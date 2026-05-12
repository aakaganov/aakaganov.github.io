import { inject } from "vue";

export default async function libraryView() {
  return {
    template: "#tpl-panel-library",
    setup() {
      return inject("shelftalk");
    },
  };
}
