import { inject } from "vue";

export default async function channelView() {
  return {
    template: "#tpl-channel",
    setup() {
      return inject("shelftalk");
    },
  };
}
