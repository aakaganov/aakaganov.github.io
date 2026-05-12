import { ref, inject } from "vue";

export default async function joinView() {
  return {
    template: "#tpl-panel-join",
    setup() {
      const joinTab = ref("find");
      return { joinTab, ...inject("shelftalk") };
    },
  };
}
