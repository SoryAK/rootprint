import type { LogHit } from '$lib/types';
import { formatCell } from './column-width';
import { getByPath } from './get-by-path';

/** A virtual-list row: a standalone hit, or a fold summary for a consecutive run. */
export type LogListRow =
	| { kind: 'hit'; hit: LogHit }
	| {
			kind: 'fold';
			id: string;
			hit: LogHit;
			endHit: LogHit;
			count: number;
			expanded: boolean;
	  };

/**
 * Identity of a row for folding: every visible column except the timestamp.
 * Level is always visible (color bar), so it is included even when it is not
 * a table column.
 */
export function foldKey(
	hit: LogHit,
	columns: readonly string[],
	timestampField: string | undefined
): string {
	const parts = [hit.level];
	for (const column of columns) {
		if (timestampField !== undefined && column === timestampField) continue;
		parts.push(`${column}:${formatCell(getByPath(hit.raw, column))}`);
	}
	return parts.join('\0');
}

/**
 * Collapse consecutive hits that share a fold key into summary rows.
 * A fold's id is its first hit's key. When that id is in `expanded`, the
 * remaining hits in the run are emitted after the summary.
 */
export function foldConsecutiveHits(
	hits: readonly LogHit[],
	columns: readonly string[],
	timestampField: string | undefined,
	expanded: ReadonlySet<string>
): LogListRow[] {
	if (hits.length === 0) return [];

	const rows: LogListRow[] = [];
	let runStart = 0;
	const firstHit = hits[0];
	if (firstHit === undefined) return [];
	let runKey = foldKey(firstHit, columns, timestampField);

	const flush = (end: number) => {
		const first = hits[runStart];
		if (first === undefined) return;
		const count = end - runStart;
		if (count === 1) {
			rows.push({ kind: 'hit', hit: first });
			return;
		}
		const last = hits[end - 1];
		if (last === undefined) return;
		const id = first.key;
		const isExpanded = expanded.has(id);
		rows.push({ kind: 'fold', id, hit: first, endHit: last, count, expanded: isExpanded });
		if (isExpanded) {
			for (let j = runStart + 1; j < end; j++) {
				const child = hits[j];
				if (child !== undefined) rows.push({ kind: 'hit', hit: child });
			}
		}
	};

	for (let i = 1; i < hits.length; i++) {
		const next = hits[i];
		if (next === undefined) continue;
		const key = foldKey(next, columns, timestampField);
		if (key === runKey) continue;
		flush(i);
		runStart = i;
		runKey = key;
	}
	flush(hits.length);
	return rows;
}
