import { inject } from "vue";

export default async function readerProfileView() {
  return {
    template: "#tpl-reader",
    setup() {
      return inject("shelftalk");
    },
  };
}
