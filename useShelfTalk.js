import { ref, computed, watch } from "vue";
import { useRoute } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";

/** Shared directory for book club listings (Part A "where" for discovery). */
export const BOOK_CLUB_DIRECTORY = "bookclub-discovery";

/** Placeholder channel when no chat route is active so discover hooks stay valid. */
const IDLE_MESSAGE_CHANNEL = "00000000-0000-4000-8000-000000000000";

const bookClubCreateSchema = {
  properties: {
    value: {
      required: ["activity", "type", "name", "channel", "published"],
      properties: {
        activity: { const: "Create" },
        type: { const: "BookClub" },
        name: { type: "string" },
        channel: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};

const noteMessageSchema = {
  properties: {
    value: {
      required: ["type", "content", "published"],
      properties: {
        type: { const: "Note" },
        content: { type: "string" },
        published: { type: "number" },
        contextBook: { type: "string" },
        isBlurred: { type: "boolean" },
        spoilerWarning: { type: "string" },
      },
    },
  },
};

const currentlyReadingSchema = {
  properties: {
    value: {
      required: ["type", "title", "published"],
      properties: {
        type: { const: "CurrentlyReading" },
        title: { type: "string" },
        isbn: { type: "string" },
        currentPage: { type: "number" },
        totalPages: { type: "number" },
        published: { type: "number" },
      },
    },
  },
};

export function useShelfTalk() {
  const graffiti = useGraffiti();
  const session = useGraffitiSession();
  const route = useRoute();

  const activeChatChannel = computed(() => {
    if (route.name === "chat" && route.params.chatId) {
      return String(route.params.chatId);
    }
    return null;
  });

  const selectedMessageChannel = computed(
    () => activeChatChannel.value ?? IDLE_MESSAGE_CHANNEL,
  );

  const newClubName = ref("");
  const isCreatingClub = ref(false);
  const createClubError = ref("");

  const myMessage = ref("");
  const contextBook = ref("");
  const markAsSpoiler = ref(false);
  const spoilerWarning = ref("");
  const isSending = ref(false);
  const sendError = ref("");

  const isDeleting = ref(new Set());
  const deleteError = ref("");

  const revealedMessageUrls = ref(new Set());

  watch(
    () => [route.name, route.params.chatId],
    () => {
      revealedMessageUrls.value = new Set();
    },
  );

  const profileChannel = computed(() => {
    const actor = session.value?.actor;
    return actor ? `${actor}/profile` : IDLE_MESSAGE_CHANNEL;
  });

  const newBookTitle = ref("");
  const newBookIsbn = ref("");
  const newBookCurrentPage = ref("");
  const newBookTotalPages = ref("");
  const isAddingBook = ref(false);
  const profileError = ref("");
  const isRemovingBook = ref(new Set());

  const { objects: rawProfileObjects, isFirstPoll: profilePollLoading } =
    useGraffitiDiscover(
      () => [profileChannel.value],
      currentlyReadingSchema,
      undefined,
      true,
    );

  const myCurrentlyReading = computed(() => {
    const actor = session.value?.actor;
    if (!actor) return [];
    return rawProfileObjects.value
      .filter(
        (o) =>
          o.actor === actor &&
          o.value?.type === "CurrentlyReading" &&
          typeof o.value?.title === "string",
      )
      .toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
  });

  const { objects: clubObjects, isFirstPoll: clubsLoading } = useGraffitiDiscover(
    [BOOK_CLUB_DIRECTORY],
    bookClubCreateSchema,
    undefined,
    true,
  );

  const sortedClubs = computed(() =>
    clubObjects.value.toSorted(
      (a, b) => (b.value.published ?? 0) - (a.value.published ?? 0),
    ),
  );

  const clubForActiveChat = computed(() => {
    const ch = activeChatChannel.value;
    if (!ch) return null;
    return sortedClubs.value.find((c) => c.value.channel === ch) ?? null;
  });

  const threadHeadTitle = computed(() => {
    if (!activeChatChannel.value) return "";
    return clubForActiveChat.value?.value?.name ?? "Book club chat";
  });

  const { objects: rawMessages, isFirstPoll: messagesLoading } = useGraffitiDiscover(
    () => [selectedMessageChannel.value],
    noteMessageSchema,
    undefined,
    true,
  );

  const sortedMessages = computed(() => {
    const list = rawMessages.value.filter(
      (o) => o.value?.type === "Note" && o.value?.content != null,
    );
    return list.toSorted(
      (a, b) => (a.value.published ?? 0) - (b.value.published ?? 0),
    );
  });

  const isMessageThreadLoading = computed(
    () => activeChatChannel.value != null && messagesLoading.value,
  );

  function dismissProfileError() {
    profileError.value = "";
  }

  async function addCurrentlyReadingBook() {
    const title = newBookTitle.value.trim();
    if (!title || !session.value) return;
    profileError.value = "";
    const currentPage = parseInt(String(newBookCurrentPage.value).trim(), 10);
    const totalPages = parseInt(String(newBookTotalPages.value).trim(), 10);
    if (
      (Number.isFinite(currentPage) && currentPage < 0) ||
      (Number.isFinite(totalPages) && totalPages < 0)
    ) {
      profileError.value = "Page counts cannot be negative.";
      return;
    }
    if (
      Number.isFinite(currentPage) &&
      Number.isFinite(totalPages) &&
      totalPages > 0 &&
      currentPage > totalPages
    ) {
      profileError.value = "Current page cannot be greater than total pages.";
      return;
    }
    isAddingBook.value = true;
    try {
      const value = {
        type: "CurrentlyReading",
        title,
        published: Date.now(),
      };
      const isbn = newBookIsbn.value.trim();
      if (isbn) value.isbn = isbn;
      if (Number.isFinite(currentPage)) value.currentPage = currentPage;
      if (Number.isFinite(totalPages)) value.totalPages = totalPages;
      await graffiti.post(
        {
          value,
          channels: [profileChannel.value],
        },
        session.value,
      );
      newBookTitle.value = "";
      newBookIsbn.value = "";
      newBookCurrentPage.value = "";
      newBookTotalPages.value = "";
    } catch (e) {
      profileError.value =
        e instanceof Error ? e.message : "Could not add this book to your profile.";
    } finally {
      isAddingBook.value = false;
    }
  }

  async function removeCurrentlyReadingBook(entry) {
    if (!session.value || entry.actor !== session.value.actor) return;
    profileError.value = "";
    const next = new Set(isRemovingBook.value);
    next.add(entry.url);
    isRemovingBook.value = next;
    try {
      await graffiti.delete(entry, session.value);
    } catch (e) {
      profileError.value =
        e instanceof Error ? e.message : "Could not remove this book from your profile.";
    } finally {
      const done = new Set(isRemovingBook.value);
      done.delete(entry.url);
      isRemovingBook.value = done;
    }
  }

  async function createBookClub() {
    const name = newClubName.value.trim();
    if (!name || !session.value) return;
    createClubError.value = "";
    isCreatingClub.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Create",
            type: "BookClub",
            name,
            channel: crypto.randomUUID(),
            published: Date.now(),
          },
          channels: [BOOK_CLUB_DIRECTORY],
        },
        session.value,
      );
      newClubName.value = "";
    } catch (e) {
      createClubError.value =
        e instanceof Error ? e.message : "Could not create this book club.";
    } finally {
      isCreatingClub.value = false;
    }
  }

  function toggleReveal(url) {
    const next = new Set(revealedMessageUrls.value);
    if (next.has(url)) next.delete(url);
    else next.add(url);
    revealedMessageUrls.value = next;
  }

  async function sendMessage() {
    const text = myMessage.value.trim();
    const channel = activeChatChannel.value;
    if (!text || !session.value || !channel) return;
    sendError.value = "";
    isSending.value = true;
    try {
      const value = {
        type: "Note",
        content: text,
        published: Date.now(),
      };
      const book = contextBook.value.trim();
      if (book) value.contextBook = book;
      if (markAsSpoiler.value) {
        value.isBlurred = true;
        value.spoilerWarning = spoilerWarning.value.trim() || "Spoiler";
      } else {
        value.isBlurred = false;
        value.spoilerWarning = "";
      }
      await graffiti.post(
        {
          value,
          channels: [channel],
        },
        session.value,
      );
      myMessage.value = "";
      spoilerWarning.value = "";
      markAsSpoiler.value = false;
    } catch (e) {
      sendError.value =
        e instanceof Error ? e.message : "Message could not be sent. Try again.";
    } finally {
      isSending.value = false;
    }
  }

  async function deleteMessage(message) {
    if (!session.value) return;
    deleteError.value = "";
    const pending = new Set(isDeleting.value);
    pending.add(message.url);
    isDeleting.value = pending;
    try {
      await graffiti.delete(message, session.value);
    } catch (e) {
      deleteError.value =
        e instanceof Error ? e.message : "Could not remove this message.";
    } finally {
      const done = new Set(isDeleting.value);
      done.delete(message.url);
      isDeleting.value = done;
    }
  }

  function dismissCreateError() {
    createClubError.value = "";
  }
  function dismissSendError() {
    sendError.value = "";
  }
  function dismissDeleteError() {
    deleteError.value = "";
  }

  return {
    BOOK_CLUB_DIRECTORY,
    profileChannel,
    session,
    activeChatChannel,
    clubForActiveChat,
    threadHeadTitle,
    sortedClubs,
    clubsLoading,
    newClubName,
    isCreatingClub,
    createClubError,
    createBookClub,
    sortedMessages,
    isMessageThreadLoading,
    myMessage,
    contextBook,
    markAsSpoiler,
    spoilerWarning,
    isSending,
    sendMessage,
    sendError,
    isDeleting,
    deleteMessage,
    deleteError,
    revealedMessageUrls,
    toggleReveal,
    dismissCreateError,
    dismissSendError,
    dismissDeleteError,
    profilePollLoading,
    myCurrentlyReading,
    newBookTitle,
    newBookIsbn,
    newBookCurrentPage,
    newBookTotalPages,
    isAddingBook,
    profileError,
    isRemovingBook,
    addCurrentlyReadingBook,
    removeCurrentlyReadingBook,
    dismissProfileError,
  };
}
