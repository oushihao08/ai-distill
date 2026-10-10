<!--
职责：提供纵向布局容器及对齐、间距、换行和满尺寸控制。
关键方法与用法：`className` 根据 `x`／`y`／`wrap`／`fill` 生成 UnoCSS 类，`gap` 写入像素间距；页面和组件通过 props 与默认插槽组合纵向内容。
-->

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
