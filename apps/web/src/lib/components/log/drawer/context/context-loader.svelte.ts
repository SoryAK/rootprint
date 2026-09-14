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
/** Which way a direction's window bound travels as it slides away from the anchor. */
const SIGN = { before: -1, after: 1 } as const;

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
	loadingMoreBefore = $state(false);
	loadingMoreAfter = $state(false);
	noMoreBefore = $state(false);
	noMoreAfter = $state(false);
	error = $state<string | null>(null);
	errorMoreBefore = $state<unknown>(null);
	errorMoreAfter = $state<unknown>(null);
	/** Bumps every time an initial fetch completes successfully. Pane watches this to scroll to the anchor row. */
	initEpoch = $state(0);

	// Sliding-window pagination: each direction owns a 15-min slice + offset that slides outward (resetting offset) once a slice returns < PAGE_SIZE rows, letting Quickwit prune to one time partition per request.
	#win = {
		before: { bound: 0, offset: 0, empty: 0 },
		after: { bound: 0, offset: 0, empty: 0 }
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
		this.#win.before = { bound: this.anchorTs, offset: 0, empty: 0 };
		this.#win.after = { bound: this.anchorTs, offset: 0, empty: 0 };
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
		if (rowCount >= PAGE_SIZE && w.offset + PAGE_SIZE <= MAX_OFFSET) {
			w.offset += PAGE_SIZE;
			w.empty = 0;
			return;
		}
		if (rowCount >= PAGE_SIZE) {
			const resumed =
				hitTimestampSeconds(hits[rowCount - 1], this.fieldConfig) + (dir === 'before' ? 1 : 0);
			if (Number.isFinite(resumed) && resumed !== w.bound) {
				w.bound = resumed;
				w.offset = 0;
				w.empty = 0;
				return;
			}
		}
		w.bound += SIGN[dir] * WINDOW_SECONDS;
		w.offset = 0;
		if (rowCount > 0) {
			w.empty = 0;
			return;
		}
		w.empty += 1;
		if (w.empty < MAX_EMPTY_SLIDES) return;
		if (dir === 'before') this.noMoreBefore = true;
		else this.noMoreAfter = true;
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

	async loadMoreBefore(retry = false): Promise<void> {
		if (this.#abort === null) return; // disposed
		if (this.loadingMoreBefore || this.noMoreBefore || this.loadingInitial) return;
		if (this.errorMoreBefore && !retry) return;
		this.loadingMoreBefore = true;
		this.errorMoreBefore = null;
		const thisSeq = this.#fetchSeq;
		try {
			const result = await searchLogs(this.#request('before'), this.#abort?.signal);
			if (thisSeq !== this.#fetchSeq) return;
			const fresh = this.#dedupe(result.rawHits);
			// 'desc' returns newest-first; append at the end of the list (which is also newest-first).
			this.entries = [...this.entries, ...this.#toEntries(fresh)];
			this.#advance('before', result.rawHits);
		} catch (e) {
			if (isAbortError(e)) return;
			if (thisSeq !== this.#fetchSeq) return;
			this.errorMoreBefore = e;
		} finally {
			if (thisSeq === this.#fetchSeq) this.loadingMoreBefore = false;
		}
	}

	async loadMoreAfter(retry = false): Promise<void> {
		if (this.#abort === null) return; // disposed
		if (this.loadingMoreAfter || this.noMoreAfter || this.loadingInitial) return;
		if (this.errorMoreAfter && !retry) return;
		this.loadingMoreAfter = true;
		this.errorMoreAfter = null;
		const thisSeq = this.#fetchSeq;
		try {
			const result = await searchLogs(this.#request('after'), this.#abort?.signal);
			if (thisSeq !== this.#fetchSeq) return;
			const fresh = this.#dedupe(result.rawHits);
			// 'asc' returns oldest-first; reverse so newest-first, then prepend to the list.
			this.entries = [...this.#toEntries(fresh.toReversed()), ...this.entries];
			this.#advance('after', result.rawHits);
		} catch (e) {
			if (isAbortError(e)) return;
			if (thisSeq !== this.#fetchSeq) return;
			this.errorMoreAfter = e;
		} finally {
			if (thisSeq === this.#fetchSeq) this.loadingMoreAfter = false;
		}
	}

	dispose(): void {
		this.#abort?.abort();
		this.#abort = null;
	}

	async #fetchInitial(): Promise<void> {
		this.#abort?.abort();
		this.#abort = new AbortController();
		if (!Number.isFinite(this.anchorTs)) {
			this.#failInitial('This log has an invalid timestamp; surrounding context cannot be loaded.');
			return;
		}
		const thisSeq = ++this.#fetchSeq;
		this.loadingInitial = true;
		this.error = null;
		this.errorMoreBefore = null;
		this.errorMoreAfter = null;
		this.entries = [];
		this.#seenKeys = new Set<string>([this.#anchorKey]);
		this.#resetWindows();
		this.noMoreBefore = false;
		this.noMoreAfter = false;
		// Clear any leftover load-more flags from an aborted previous round.
		this.loadingMoreBefore = false;
		this.loadingMoreAfter = false;

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

			if (afterErr) this.errorMoreAfter = afterErr;
			else this.#advance('after', afterHits);
			if (beforeErr) this.errorMoreBefore = beforeErr;
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
		this.noMoreBefore = true;
		this.noMoreAfter = true;
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
