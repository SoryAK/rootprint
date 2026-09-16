<script lang="ts">
	import { ChevronDown, ChevronRight } from 'lucide-svelte';
	import { isValid, parseISO } from 'date-fns';
	import { formatFoldSpan, formatLogRowTimestamp } from '$lib/utils/time';

	let {
		count,
		startTimestamp,
		endTimestamp,
		expanded = false,
		onToggle = () => {}
	}: {
		count: number;
		startTimestamp: string;
		endTimestamp: string;
		expanded?: boolean;
		onToggle?: () => void;
	} = $props();

	const span = $derived(formatFoldSpan(startTimestamp, endTimestamp));
	const countLabel = $derived(count.toLocaleString());
	const text = $derived(span === null ? countLabel : `${countLabel} · ${span}`);
	const fromTs = $derived.by(() => {
		const start = parseISO(startTimestamp);
		const end = parseISO(endTimestamp);
		if (!isValid(start) || !isValid(end) || start.getTime() <= end.getTime()) return startTimestamp;
		return endTimestamp;
	});
	const toTs = $derived(fromTs === startTimestamp ? endTimestamp : startTimestamp);
	const title = $derived(
		`${count.toLocaleString()} consecutive rows, ${formatLogRowTimestamp(fromTs)} – ${formatLogRowTimestamp(toTs)}, same visible columns`
	);
	const action = $derived(expanded ? 'Collapse' : 'Expand');
</script>

<button
	type="button"
	class="text-muted hover:text-base-content mr-1.5 inline-flex items-center gap-0.5 align-middle"
	aria-expanded={expanded}
	aria-label={`${action} ${text}`}
	{title}
	onclick={(event) => {
		event.stopPropagation();
		onToggle();
	}}
>
	{#if expanded}
		<ChevronDown class="h-3 w-3 shrink-0" aria-hidden="true" />
	{:else}
		<ChevronRight class="h-3 w-3 shrink-0" aria-hidden="true" />
	{/if}
	<span class="text-xs tabular-nums">{text}</span>
</button>
