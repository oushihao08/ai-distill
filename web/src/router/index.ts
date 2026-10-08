import { createRouter, createWebHistory } from 'vue-router';
import ProjectList from '../views/ProjectList.vue';
import ProjectDetail from '../views/ProjectDetail.vue';
import WorkflowDetail from '../views/WorkflowDetail.vue';
export default createRouter({ history: createWebHistory(), routes: [ { path: '/', component: ProjectList }, { path: '/projects/:id', component: ProjectDetail }, { path: '/workflows/:id', component: WorkflowDetail } ] });
