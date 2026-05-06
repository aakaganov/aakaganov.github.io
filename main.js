import { createApp, provide } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
import { GraffitiPlugin } from "@graffiti-garden/wrapper-vue";
import { useShelfTalk } from "./useShelfTalk.js";

function loadComponent(name) {
  return () => import(`./${name}/main.js`).then((m) => m.default());
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: loadComponent("home") },
    { path: "/about", name: "about", component: loadComponent("about") },
    { path: "/books", name: "books", component: loadComponent("books") },
    {
      path: "/chat/:chatId",
      name: "chat",
      component: loadComponent("chat"),
      props: true,
    },
    { path: "/dms", name: "dms", component: loadComponent("dms") },
    {
      path: "/dm/:peerKey",
      name: "dm",
      component: loadComponent("dm"),
      props: true,
    },
    {
      path: "/reader/:peerKey",
      name: "reader",
      component: loadComponent("reader"),
      props: true,
    },
    { path: "/channel", name: "channel", component: loadComponent("channel") },
  ],
});

const App = {
  template: "#template",
  setup() {
    const shelftalk = useShelfTalk();
    provide("shelftalk", shelftalk);
    return shelftalk;
  },
};

createApp(App)
  .use(router)
  .use(GraffitiPlugin, {
    graffiti: new GraffitiDecentralized(),
  })
  .mount("#app");
