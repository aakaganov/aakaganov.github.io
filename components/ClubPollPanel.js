import { inject } from "vue";

export default {
  name: "ClubPollPanel",
  template: "#tpl-club-poll",
  setup() {
    return inject("shelftalk");
  },
};
