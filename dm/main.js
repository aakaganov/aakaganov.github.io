import { inject } from "vue";
import ChatMessage from "../components/ChatMessage.js";

export default async function dmView() {
  return {
    template: "#tpl-dm",
    components: { ChatMessage },
    setup() {
      return inject("shelftalk");
    },
  };
}
