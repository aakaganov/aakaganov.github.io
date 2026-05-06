import { inject } from "vue";

export default async function booksView() {
  return {
    template: "#tpl-books",
    setup() {
      return inject("shelftalk");
    },
  };
}
