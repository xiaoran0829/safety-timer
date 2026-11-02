import { createApp } from 'vue';
import { createPinia } from 'pinia';
import Vant from 'vant';
import 'vant/lib/index.css';
import './styles.css';
import App from './App.vue';
import router from './router';
import { useAppStore } from './stores/app';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(Vant);
useAppStore().restore();
app.mount('#app');
