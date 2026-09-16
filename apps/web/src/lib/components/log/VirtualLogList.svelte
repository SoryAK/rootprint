<script lang="ts">
	import { get } from 'svelte/store';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import LogHeader from './LogHeader.svelte';
	import LogRow from './LogRow.svelte';
	import InlineLogRow from './InlineLogRow.svelte';
	import type { FieldConfig, LogHit, SortDirection } from '$lib/types';
	import type { LogListRow } from '$lib/utils/fold-hits';
	import type { DisplayMode } from 'api/types';

	const ROW_ESTIMATE = 25;
	const OVERSCAN = 8;

	let {
		rows,
		activeFields,
		gridTemplate,
		fieldConfig,
		sortDirection,
		viewport,
		lineWrap = false,
		displayMode = 'table',
		listEnd = 'more',
		onToggleSort = () => {},
		onRowClick = () => {},
		onToggleFold = () => {}
	}: {
		rows: LogListRow[];
		activeFields: string[];
		gridTemplate: string;
		fieldConfig: FieldConfig | null;
		sortDirection: SortDirection;
		viewport: HTMLElement | null;
		lineWrap?: boolean;
		displayMode?: DisplayMode;
		listEnd?: 'more' | 'end' | 'capped';
		onToggleSort?: () => void;
		onRowClick?: (hit: LogHit) => void;
		onToggleFold?: (id: string) => void;
	} = $props();

	let headerEl = $state<HTMLElement | null>(null);
	let scrollMargin = $state(0);

	const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
		count: rows.length,
		getScrollElement: () => viewport,
		estimateSize: () => ROW_ESTIMATE,
		overscan: OVERSCAN,
		scrollMargin: 0
	});

	const messageField = $derived(fieldConfig?.messageField);

	function measure(node: HTMLElement) {
		get(virtualizer).measureElement(node);
	}

	function rowKey(row: LogListRow | undefined, index: number): string {
		if (!row) return String(index);
		return row.kind === 'fold' ? `fold:${row.id}` : `hit:${row.hit.key}`;
	}

	$effect(() => {
		const el = headerEl;
		if (el === null) {
			scrollMargin = 0;
			return;
		}
		const ro = new ResizeObserver(() => (scrollMargin = el.offsetHeight));
		ro.observe(el);
		return () => ro.disconnect();
	});

	$effect(() => {
		const count = rows.length;
		const margin = scrollMargin;
		const el = viewport;
		const v = get(virtualizer);
		v.setOptions({
			count,
			scrollMargin: margin,
			getScrollElement: () => el,
			estimateSize: () => ROW_ESTIMATE
		});
	});
</script>

<div class="w-fit min-w-full">
	{#if displayMode === 'table'}
		<LogHeader
			bind:el={headerEl}
			{fieldConfig}
			columns={activeFields}
			{gridTemplate}
			{sortDirection}
			{lineWrap}
			{onToggleSort}
		/>
	{/if}
	<div class="relative w-full" style="height: {$virtualizer.getTotalSize()}px;">
		{#each $virtualizer.getVirtualItems() as item (rowKey(rows[item.index], item.index))}
			{#if rows[item.index]}
				{@const row = rows[item.index]}
				<div
					{@attach measure}
					data-index={item.index}
					class="absolute top-0 left-0 w-full"
					style="transform: translateY({item.start - scrollMargin}px);"
				>
					{#if displayMode === 'inline'}
						<InlineLogRow
							hit={row.hit}
							columns={activeFields}
							{lineWrap}
							foldCount={row.kind === 'fold' ? row.count : null}
							foldExpanded={row.kind === 'fold' ? row.expanded : false}
							foldEndTimestamp={row.kind === 'fold' ? row.endHit.timestamp : null}
							onActivate={() => (row.kind === 'fold' ? onToggleFold(row.id) : onRowClick(row.hit))}
							onToggleFold={() => row.kind === 'fold' && onToggleFold(row.id)}
						/>
					{:else}
						<LogRow
							hit={row.hit}
							columns={activeFields}
							{gridTemplate}
							{messageField}
							{lineWrap}
							foldCount={row.kind === 'fold' ? row.count : null}
							foldExpanded={row.kind === 'fold' ? row.expanded : false}
							foldEndTimestamp={row.kind === 'fold' ? row.endHit.timestamp : null}
							onActivate={() => (row.kind === 'fold' ? onToggleFold(row.id) : onRowClick(row.hit))}
							onToggleFold={() => row.kind === 'fold' && onToggleFold(row.id)}
						/>
					{/if}
				</div>
			{/if}
		{/each}
	</div>
	{#if listEnd !== 'more'}
		<div class="border-line text-muted sticky left-0 w-fit border-t px-3 py-4 text-xs">
			{#if listEnd === 'capped'}
				Showing the first 10,000 logs. Narrow the time range to see the rest.
			{:else}
				End of results
			{/if}
		</div>
	{/if}
</div>
