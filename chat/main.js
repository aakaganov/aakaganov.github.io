import { inject } from "vue";

export default async function chatView() {
  return {
    template: "#tpl-chat",
    setup() {
      return inject("shelftalk");
    },
  };
}
