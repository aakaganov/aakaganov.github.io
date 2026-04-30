import { inject } from "vue";
import ChatMessage from "../components/ChatMessage.js";

export default async function chatView() {
  return {
    template: "#tpl-chat",
    components: { ChatMessage },
    setup() {
      return inject("shelftalk");
    },
  };
}
