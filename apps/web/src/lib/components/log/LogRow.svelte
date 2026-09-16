<script lang="ts">
	import type { LogHit } from '$lib/types';
	import { levelColor } from '$lib/constants/level-colors';
	import { formatLogRowTimestamp } from '$lib/utils/time';
	import { getByPath } from '$lib/utils/get-by-path';
	import { formatCell } from '$lib/utils/column-width';
	import { rowActivate } from '$lib/attachments/row-activate';
	import FoldBadge from './FoldBadge.svelte';

	let {
		hit,
		columns,
		gridTemplate,
		messageField,
		lineWrap = false,
		isAnchor = false,
		foldCount = null,
		foldExpanded = false,
		foldEndTimestamp = null,
		onActivate = () => {},
		onToggleFold = () => {}
	}: {
		hit: LogHit;
		columns: string[];
		gridTemplate: string;
		messageField?: string;
		lineWrap?: boolean;
		isAnchor?: boolean;
		foldCount?: number | null;
		foldExpanded?: boolean;
		foldEndTimestamp?: string | null;
		onActivate?: () => void;
		onToggleFold?: () => void;
	} = $props();

	const cellWrap = $derived(
		lineWrap ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-nowrap'
	);
	const messageWrap = $derived(lineWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-nowrap');
	const rowWidth = $derived(lineWrap ? 'w-full' : 'w-max min-w-full');
	const foldColumn = $derived(
		messageField && columns.includes(messageField) ? messageField : columns[0]
	);
</script>

<div
	role="button"
	tabindex="0"
	data-anchor={isAnchor ? 'true' : null}
	aria-current={isAnchor ? 'true' : undefined}
	class={[
		'border-line grid min-h-[25px] items-stretch border-b text-left font-mono text-xs hover:bg-[color-mix(in_oklab,var(--level-color)_14%,transparent)]',
		rowWidth,
		isAnchor && 'bg-[color-mix(in_oklab,var(--level-color)_10%,transparent)]'
	]}
	style="grid-template-columns: {gridTemplate}; --level-color: {levelColor(hit.level)};"
	{@attach rowActivate(() => onActivate)}
>
	<span
		title={hit.level.trim().toUpperCase() || 'UNKNOWN'}
		class="my-[1px]"
		style="background-color: var(--level-color);"
		><span class="sr-only">Severity: {hit.level.trim() || 'unknown'}. </span></span
	>
	<span class="text-muted px-2 py-1" title={hit.timestamp}>
		{formatLogRowTimestamp(hit.timestamp)}
	</span>
	{#each columns as column (column)}
		{@const cell = formatCell(getByPath(hit.raw, column))}
		<span
			class="px-2 py-1 {column === messageField ? messageWrap : cellWrap}"
			title={column === messageField || lineWrap ? undefined : cell}
		>
			{#if foldCount !== null && foldEndTimestamp !== null && column === foldColumn}
				<FoldBadge
					count={foldCount}
					startTimestamp={hit.timestamp}
					endTimestamp={foldEndTimestamp}
					expanded={foldExpanded}
					onToggle={onToggleFold}
				/>
			{/if}
			{cell}
		</span>
	{/each}
</div>
