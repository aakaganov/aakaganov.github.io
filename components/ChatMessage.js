import { inject } from "vue";

export default {
  name: "ChatMessage",
  props: {
    msg: { type: Object, required: true },
  },
  template: "#tpl-message-row",
  setup() {
    return inject("shelftalk");
  },
};
