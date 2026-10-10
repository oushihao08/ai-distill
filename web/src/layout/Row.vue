<!--
职责：提供横向布局容器及对齐、间距、换行和响应式主轴切换。
关键方法与用法：`className` 根据 `x`／`y`／`stackOnMobile`／`stackOnDesktop` 生成 UnoCSS 类；页面和组件通过 props 与默认插槽组合横向内容。
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
