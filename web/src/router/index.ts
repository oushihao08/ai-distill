/** 文件职责：声明工作台的全局导航、期次/材料库及工作流详情路由。
 * 关键配置与用法：根路径加载主项目列表，/project-groups/:groupId 加载主项目期次列表；材料库、监控、成果库、系统设置和详情路由由对应页面组件承载。
 */
import { createRouter, createWebHistory } from 'vue-router';
import ProjectList from '../views/ProjectList.vue';
import ProjectDetail from '../views/ProjectDetail.vue';
import WorkflowDetail from '../views/WorkflowDetail.vue';
import MonitorView from '../views/MonitorView.vue';
import ResultsLibraryView from '../views/ResultsLibraryView.vue';
import SettingsView from '../views/SettingsView.vue';
import MaterialLibraryView from '../views/MaterialLibraryView.vue';
import ProjectGroups from '../views/ProjectGroups.vue';
export default createRouter({ history: createWebHistory(), routes: [ { path: '/', component: ProjectGroups }, { path:'/project-groups/:groupId',component:ProjectList }, { path: '/materials/:packageId?', component: MaterialLibraryView }, { path: '/monitor', component: MonitorView }, { path: '/results', component: ResultsLibraryView }, { path: '/settings', component: SettingsView }, { path: '/projects/:id', component: ProjectDetail }, { path: '/workflows/:id', component: WorkflowDetail } ] });
