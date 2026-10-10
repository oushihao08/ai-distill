/** 文件职责：声明工作台的全局导航、项目详情及单题详情路由。
 * 关键配置与用法：根路径加载项目列表，/monitor、/results、/settings 分别加载监控、成果库和系统设置；项目与工作流路由加载对应详情页。
 */
import { createRouter, createWebHistory } from 'vue-router';
import ProjectList from '../views/ProjectList.vue';
import ProjectDetail from '../views/ProjectDetail.vue';
import WorkflowDetail from '../views/WorkflowDetail.vue';
import MonitorView from '../views/MonitorView.vue';
import ResultsLibraryView from '../views/ResultsLibraryView.vue';
import SettingsView from '../views/SettingsView.vue';
export default createRouter({ history: createWebHistory(), routes: [ { path: '/', component: ProjectList }, { path: '/monitor', component: MonitorView }, { path: '/results', component: ResultsLibraryView }, { path: '/settings', component: SettingsView }, { path: '/projects/:id', component: ProjectDetail }, { path: '/workflows/:id', component: WorkflowDetail } ] });
