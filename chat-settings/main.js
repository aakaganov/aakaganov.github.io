import { inject } from "vue";

export default async function chatSettingsView() {
  return {
    template: "#tpl-chat-settings",
    setup() {
      return inject("shelftalk");
    },
  };
}
