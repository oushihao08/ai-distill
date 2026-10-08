<script setup lang="ts">
import { computed } from 'vue'

type Align = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly' | 'stretch'

const props = withDefaults(defineProps<{
  x?: Align
  y?: Align
  gap?: number
  wrap?: boolean
  fill?: boolean
}>(), { x: 'stretch', y: 'start', gap: 0, wrap: false, fill: false })

const className = computed(() => [
  'box-border flex flex-col',
  `justify-${['start', 'center', 'end', 'between', 'around', 'evenly'].includes(props.y) ? props.y : 'start'}`,
  `items-${['start', 'center', 'end', 'stretch'].includes(props.x) ? props.x : 'start'}`,
  props.wrap ? 'flex-wrap' : '',
  props.fill ? 'w-full h-full' : '',
])
</script>

<template>
  <div :class="className" :style="{ gap: `${gap}px` }"><slot /></div>
</template>
