<script setup lang="ts">
import { computed } from 'vue'

type Align = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly' | 'stretch'

const props = withDefaults(defineProps<{
  x?: Align
  y?: Align
  gap?: number
  wrap?: boolean
  fill?: boolean
  stackOnMobile?: boolean
  stackOnDesktop?: boolean
}>(), { x: 'start', y: 'center', gap: 0, wrap: false, fill: false, stackOnMobile: false, stackOnDesktop: false })

const className = computed(() => [
  'box-border flex',
  props.stackOnMobile ? 'flex-col lg:flex-row' : props.stackOnDesktop ? 'flex-row lg:flex-col' : 'flex-row',
  `justify-${['start', 'center', 'end', 'between', 'around', 'evenly'].includes(props.x) ? props.x : 'start'}`,
  `items-${['start', 'center', 'end', 'stretch'].includes(props.y) ? props.y : 'start'}`,
  props.wrap ? 'flex-wrap' : '',
  props.fill ? 'w-full h-full' : '',
])
</script>

<template>
  <div :class="className" :style="{ gap: `${gap}px` }"><slot /></div>
</template>
