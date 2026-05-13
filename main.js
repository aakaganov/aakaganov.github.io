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
    { path: "/", redirect: { name: "clubs" } },
    { path: "/clubs", name: "clubs", component: loadComponent("clubs") },
    { path: "/library", name: "library", component: loadComponent("library") },
    { path: "/join", name: "join", component: loadComponent("join") },
    { path: "/about", name: "about", component: loadComponent("about") },
    { path: "/books", name: "books", component: loadComponent("books") },
    {
      path: "/chat/:chatId/poll",
      name: "chat-poll",
      component: loadComponent("chat-poll"),
      props: true,
    },
    {
      path: "/chat/:chatId/settings",
      name: "chat-settings",
      component: loadComponent("chat-settings"),
      props: true,
    },
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
