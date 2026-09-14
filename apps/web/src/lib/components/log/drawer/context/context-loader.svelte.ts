import { searchLogs } from '$lib/api/log-search';
import { isAbortError } from '$lib/api/errors';
import { getByPath } from '$lib/utils/get-by-path';
import { escapeFilterValue } from 'api/query';
import { hitTimestampSeconds, normalizeHit } from '$lib/utils/normalize-hit';
import type { ContextChip, ContextEntry, FieldConfig, LogHit, SearchInput } from '$lib/types';

const PAGE_SIZE = 200;
const WINDOW_SECONDS = 15 * 60;
/** After this many consecutive fully-empty slides in one direction, stop walking. */
const MAX_EMPTY_SLIDES = 3;
const MAX_OFFSET = 10_000;

type Dir = 'before' | 'after';
const SIGN = { before: -1, after: 1 } as const;

function createDirectionState(): {
	loading: boolean;
	noMore: boolean;
	limited: boolean;
	error: unknown;
} {
	return { loading: false, noMore: false, limited: false, error: null };
}

export function seedChipsFromIndex(
	anchor: Record<string, unknown>,
	fields: readonly string[]
): ContextChip[] {
	const out: ContextChip[] = [];
	for (const field of fields) {
		const value = getByPath(anchor, field);
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' && value.length === 0) continue;
		out.push({ field, value });
	}
	return out;
}

function hitKey(hit: Record<string, unknown>): string {
	const id = hit['_id'];
	if (typeof id === 'string' && id.length > 0) return id;
	return JSON.stringify(hit);
}

export class ContextLoader {
	readonly anchor: LogHit;
	readonly anchorTs: number; // seconds since epoch
	readonly indexId: string;
	readonly fieldConfig: FieldConfig;

	chips = $state<ContextChip[]>([]);
	entries = $state.raw<ContextEntry[]>([]);

	loadingInitial = $state(false);
	before = $state(createDirectionState());
	after = $state(createDirectionState());
	error = $state<string | null>(null);
	/** Pane watches this to scroll to the anchor after initial results or a failure. */
	initEpoch = $state(0);

	// Sliding-window pagination: each direction owns a 15-min slice + offset that slides outward (resetting offset) once a slice returns < PAGE_SIZE rows, letting Quickwit prune to one time partition per request.
	#win = {
		before: { bound: 0, offset: 0, empty: 0, boundaryTs: NaN, boundaryCount: 0 },
		after: { bound: 0, offset: 0, empty: 0, boundaryTs: NaN, boundaryCount: 0 }
	};
	#seenKeys = new Set<string>();
	#abort: AbortController | null = null;
	#fetchSeq = 0;
	#nextEntryKey = 0;
	readonly #anchorKey: string;

	constructor(
		anchor: LogHit,
		indexId: string,
		fieldConfig: FieldConfig,
		initialChips: ContextChip[] = []
	) {
		this.anchor = anchor;
		this.indexId = indexId;
		this.fieldConfig = fieldConfig;
		// NaN when the timestamp is missing/unparseable — #fetchInitial bails out then.
		this.anchorTs = hitTimestampSeconds(anchor.raw, fieldConfig);
		this.#resetWindows();
		this.#anchorKey = hitKey(anchor.raw);
		this.chips = initialChips;
	}

	#resetWindows(): void {
		for (const dir of ['before', 'after'] as const) {
			this.#win[dir] = {
				bound: this.anchorTs,
				offset: 0,
				empty: 0,
				boundaryTs: NaN,
				boundaryCount: 0
			};
		}
	}

	#request(dir: Dir): SearchInput {
		const { bound, offset } = this.#win[dir];
		const desc = dir === 'before';
		return {
			indexId: this.indexId,
			query: this.composedQuery,
			limit: PAGE_SIZE,
			offset,
			sortDirection: desc ? 'desc' : 'asc',
			startTs: desc ? bound - WINDOW_SECONDS : bound,
			endTs: desc ? bound : bound + WINDOW_SECONDS
		};
	}

	#advance(dir: Dir, hits: Record<string, unknown>[]): void {
		const w = this.#win[dir];
		const rowCount = hits.length;
		if (rowCount >= PAGE_SIZE) {
			const boundaryTs = hitTimestampSeconds(hits[rowCount - 1], this.fieldConfig);
			let boundaryCount = 1;
			for (let i = rowCount - 2; i >= 0; i--) {
				if (hitTimestampSeconds(hits[i], this.fieldConfig) !== boundaryTs) break;
				boundaryCount++;
			}
			// A resumed window includes this whole second; retain its consumed offset to avoid replaying it.
			w.boundaryCount =
				boundaryCount === rowCount && boundaryTs === w.boundaryTs
					? w.boundaryCount + boundaryCount
					: boundaryCount;
			w.boundaryTs = boundaryTs;
			w.empty = 0;
			if (w.offset + PAGE_SIZE <= MAX_OFFSET) {
				w.offset += PAGE_SIZE;
				return;
			}
			const resumed = boundaryTs + (dir === 'before' ? 1 : 0);
			if (
				Number.isFinite(resumed) &&
				SIGN[dir] * (resumed - w.bound) > 0 &&
				w.boundaryCount <= MAX_OFFSET
			) {
				w.bound = resumed;
				w.offset = w.boundaryCount;
			} else {
				// A saturated second cannot be traversed safely without a tie-aware cursor.
				this[dir].limited = true;
			}
			return;
		}
		w.bound += SIGN[dir] * WINDOW_SECONDS;
		w.offset = 0;
		w.boundaryTs = NaN;
		w.boundaryCount = 0;
		if (rowCount > 0) {
			w.empty = 0;
			return;
		}
		w.empty += 1;
		if (w.empty < MAX_EMPTY_SLIDES) return;
		this[dir].noMore = true;
	}

	/** AND-joined chip query used by internal fetches; '*' when no chips. */
	get composedQuery(): string {
		const clause = this.#buildChipClause();
		return clause === '' ? '*' : clause;
	}

	#buildChipClause(): string {
		if (this.chips.length === 0) return '';
		return this.chips.map((c) => `${c.field}:${escapeFilterValue(String(c.value))}`).join(' AND ');
	}

	async init(): Promise<void> {
		await this.#fetchInitial();
	}

	async setChips(chips: ContextChip[]): Promise<void> {
		if (this.#abort === null) return; // disposed or not yet initialized
		this.chips = chips;
		await this.#fetchInitial();
	}

	/** Search-page handoff: chip clause + the ±15-minute absolute window centered on the anchor. */
	getSearchHandoff(): { query: string; start: number; end: number } {
		return {
			query: this.#buildChipClause(),
			start: this.anchorTs - WINDOW_SECONDS,
			end: this.anchorTs + WINDOW_SECONDS
		};
	}

	loadMoreBefore(retry = false): Promise<void> {
		return this.#loadMore('before', retry);
	}

	loadMoreAfter(retry = false): Promise<void> {
		return this.#loadMore('after', retry);
	}

	async #loadMore(dir: Dir, retry: boolean): Promise<void> {
		if (this.#abort === null || this.loadingInitial || this.error) return;
		const state = this[dir];
		if (state.loading || state.noMore || state.limited) return;
		if (state.error && !retry) return;
		state.loading = true;
		state.error = null;
		const thisSeq = this.#fetchSeq;
		try {
			const result = await searchLogs(this.#request(dir), this.#abort.signal);
			if (thisSeq !== this.#fetchSeq) return;
			const fresh = this.#dedupe(result.rawHits);
			if (fresh.length > 0) {
				this.entries =
					dir === 'before'
						? [...this.entries, ...this.#toEntries(fresh)]
						: [...this.#toEntries(fresh.toReversed()), ...this.entries];
			}
			this.#advance(dir, result.rawHits);
		} catch (e) {
			if (isAbortError(e)) return;
			if (thisSeq !== this.#fetchSeq) return;
			state.error = e;
		} finally {
			if (thisSeq === this.#fetchSeq) state.loading = false;
		}
	}

	dispose(): void {
		this.#fetchSeq++;
		this.#abort?.abort();
		this.#abort = null;
	}

	async #fetchInitial(): Promise<void> {
		this.#abort?.abort();
		this.#abort = new AbortController();
		const thisSeq = ++this.#fetchSeq;
		this.before = createDirectionState();
		this.after = createDirectionState();
		if (!Number.isFinite(this.anchorTs)) {
			this.#failInitial('This log has an invalid timestamp; surrounding context cannot be loaded.');
			return;
		}
		this.loadingInitial = true;
		this.error = null;
		this.entries = [];
		this.#seenKeys = new Set<string>([this.#anchorKey]);
		this.#resetWindows();

		try {
			const [afterRes, beforeRes] = await Promise.allSettled([
				searchLogs(this.#request('after'), this.#abort.signal),
				searchLogs(this.#request('before'), this.#abort.signal)
			]);

			if (thisSeq !== this.#fetchSeq) return;

			const afterErr = afterRes.status === 'rejected' ? afterRes.reason : null;
			const beforeErr = beforeRes.status === 'rejected' ? beforeRes.reason : null;
			if (isAbortError(afterErr) || isAbortError(beforeErr)) return;
			if (afterErr && beforeErr) {
				this.#failInitial();
				return;
			}

			const afterHits = afterRes.status === 'fulfilled' ? afterRes.value.rawHits : [];
			const beforeHits = beforeRes.status === 'fulfilled' ? beforeRes.value.rawHits : [];
			const afterFresh = this.#dedupe(afterHits);
			const beforeFresh = this.#dedupe(beforeHits);

			// Final order: newest first. 'asc' results reversed → newest; anchor in middle; 'desc' results → older.
			this.entries = [
				...this.#toEntries(afterFresh.toReversed()),
				this.#toEntry(this.anchor.raw, true),
				...this.#toEntries(beforeFresh)
			];
			this.initEpoch++;

			if (afterErr) this.after.error = afterErr;
			else this.#advance('after', afterHits);
			if (beforeErr) this.before.error = beforeErr;
			else this.#advance('before', beforeHits);
		} catch {
			if (thisSeq !== this.#fetchSeq) return;
			this.#failInitial();
		} finally {
			if (thisSeq === this.#fetchSeq) this.loadingInitial = false;
		}
	}

	#failInitial(
		message = 'Failed to fetch log context. Check your connection and try again.'
	): void {
		this.error = message;
		this.entries = [this.#toEntry(this.anchor.raw, true)];
		this.initEpoch++;
	}

	#dedupe(hits: Record<string, unknown>[]): Record<string, unknown>[] {
		const out: Record<string, unknown>[] = [];
		for (const h of hits) {
			const k = hitKey(h);
			if (this.#seenKeys.has(k)) continue;
			this.#seenKeys.add(k);
			out.push(h);
		}
		return out;
	}

	#toEntries(hits: Record<string, unknown>[]): ContextEntry[] {
		return hits.map((h) => this.#toEntry(h, false));
	}

	#toEntry(hit: Record<string, unknown>, isAnchor: boolean): ContextEntry {
		return { ...normalizeHit(hit, this.#nextEntryKey++, this.fieldConfig), isAnchor };
	}
}
