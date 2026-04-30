import { inject } from "vue";

export default async function dmsView() {
  return {
    template: "#tpl-dms",
    setup() {
      return inject("shelftalk");
    },
  };
}
