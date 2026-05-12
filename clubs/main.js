import { inject } from "vue";

export default async function clubsView() {
  return {
    template: "#tpl-panel-clubs",
    setup() {
      return inject("shelftalk");
    },
  };
}
