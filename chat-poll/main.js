import { inject } from "vue";
import ClubPollPanel from "../components/ClubPollPanel.js";

export default async function chatPollView() {
  return {
    template: "#tpl-chat-poll",
    components: { ClubPollPanel },
    setup() {
      return inject("shelftalk");
    },
  };
}
