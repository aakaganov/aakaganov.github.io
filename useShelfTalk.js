import { ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";
import { directMessageChannelId, peerToKey, keyToPeer } from "./directMessage.js";

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
        status: { type: "string" },
        statusUpdatedAt: { type: "number" },
        published: { type: "number" },
      },
    },
  },
};

const dmThreadIndexSchema = {
  properties: {
    value: {
      required: ["type", "peerActor", "updated"],
      properties: {
        type: { const: "DMThreadIndex" },
        peerActor: { type: "string" },
        updated: { type: "number" },
        lastPreview: { type: "string" },
      },
    },
  },
};

export function useShelfTalk() {
  const graffiti = useGraffiti();
  const session = useGraffitiSession();
  const route = useRoute();
  const router = useRouter();

  /** Book-club thread channel when on <code>/chat/:chatId</code>. */
  const activeClubChannel = computed(() => {
    if (route.name === "chat" && route.params.chatId) {
      return String(route.params.chatId);
    }
    return null;
  });

  /** Kept as alias for club-only logic (sidebar active state, club metadata). */
  const activeChatChannel = activeClubChannel;

  const dmPeerActor = computed(() => {
    if (route.name !== "dm" || route.params.peerKey == null) return null;
    try {
      const peer = keyToPeer(String(route.params.peerKey));
      return peer.trim() ? peer : null;
    } catch {
      return null;
    }
  });

  const readerProfilePeerActor = computed(() => {
    if (route.name !== "reader" || route.params.peerKey == null) return null;
    try {
      const peer = keyToPeer(String(route.params.peerKey));
      return peer.trim() ? peer : null;
    } catch {
      return null;
    }
  });

  const readerProfileInvalid = computed(
    () =>
      route.name === "reader" && Boolean(route.params.peerKey) && readerProfilePeerActor.value == null,
  );

  const readerProfileDiscoverChannel = computed(() => {
    const peer = readerProfilePeerActor.value;
    return peer ? `${peer}/profile` : IDLE_MESSAGE_CHANNEL;
  });

  const { objects: rawReaderProfileObjects, isFirstPoll: readerProfilePollLoading } =
    useGraffitiDiscover(
      () => [readerProfileDiscoverChannel.value],
      currentlyReadingSchema,
      undefined,
      true,
    );

  const readerCurrentlyReading = computed(() => {
    const peer = readerProfilePeerActor.value;
    if (!peer) return [];
    return rawReaderProfileObjects.value
      .filter(
        (o) =>
          o.actor === peer &&
          o.value?.type === "CurrentlyReading" &&
          typeof o.value?.title === "string",
      )
      .toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
  });

  function splitBooksByStatus(entries) {
    const grouped = {
      reading: [],
      finished: [],
      dnf: [],
    };
    for (const entry of entries) {
      grouped[normalizeBookStatus(entry.value?.status)].push(entry);
    }
    return grouped;
  }

  const readerBooksByStatus = computed(() => splitBooksByStatus(readerCurrentlyReading.value));

  const dmPeerInvalid = computed(
    () => route.name === "dm" && Boolean(route.params.peerKey) && dmPeerActor.value == null,
  );

  const dmSelfConversation = computed(
    () =>
      route.name === "dm" &&
      dmPeerActor.value != null &&
      session.value?.actor != null &&
      dmPeerActor.value === session.value.actor,
  );

  const selectedMessageChannel = computed(() => {
    if (activeClubChannel.value) return activeClubChannel.value;
    if (
      route.name === "dm" &&
      dmPeerActor.value &&
      session.value?.actor &&
      dmPeerActor.value !== session.value.actor
    ) {
      return directMessageChannelId(session.value.actor, dmPeerActor.value);
    }
    return IDLE_MESSAGE_CHANNEL;
  });

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
    () => [
      route.name,
      route.params.chatId,
      route.params.peerKey,
      readerProfileDiscoverChannel.value,
    ],
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
  const isUpdatingBook = ref(new Set());
  const bookPageDrafts = ref({});

  const { objects: rawProfileObjects, isFirstPoll: profilePollLoading } =
    useGraffitiDiscover(
      () => [profileChannel.value],
      currentlyReadingSchema,
      undefined,
      true,
    );

  const { objects: rawDmIndexObjects } = useGraffitiDiscover(
    () => [profileChannel.value],
    dmThreadIndexSchema,
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

  const myBooksByStatus = computed(() => splitBooksByStatus(myCurrentlyReading.value));

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
    const ch = activeClubChannel.value;
    if (!ch) return null;
    return sortedClubs.value.find((c) => c.value.channel === ch) ?? null;
  });

  const threadHeadTitle = computed(() => {
    if (!activeClubChannel.value) return "";
    return clubForActiveChat.value?.value?.name ?? "Book club chat";
  });

  const dmChannelPreview = computed(() => {
    if (route.name !== "dm" || !dmPeerActor.value || !session.value?.actor) return "";
    if (dmPeerActor.value === session.value.actor) return "";
    return directMessageChannelId(session.value.actor, dmPeerActor.value);
  });

  const dmInboxRows = computed(() => {
    const actor = session.value?.actor;
    if (!actor) return [];
    const best = new Map();
    for (const o of rawDmIndexObjects.value) {
      if (o.actor !== actor || o.value?.type !== "DMThreadIndex") continue;
      const peer = o.value.peerActor;
      if (typeof peer !== "string" || !peer) continue;
      const updated = o.value.updated ?? 0;
      const cur = best.get(peer);
      if (!cur || updated >= cur.updated) {
        best.set(peer, {
          peerActor: peer,
          updated,
          lastPreview: typeof o.value.lastPreview === "string" ? o.value.lastPreview : "",
        });
      }
    }
    return [...best.values()].toSorted((a, b) => b.updated - a.updated);
  });

  const newDmPeerInput = ref("");

  function openNewDm() {
    const raw = newDmPeerInput.value.trim();
    if (!raw) return;
    router.push({ name: "dm", params: { peerKey: peerToKey(raw) } });
    newDmPeerInput.value = "";
  }

  async function recordDmThread(peerActor, previewSnippet) {
    if (!session.value?.actor || !peerActor || peerActor === session.value.actor) return;
    try {
      await graffiti.post(
        {
          value: {
            type: "DMThreadIndex",
            peerActor,
            updated: Date.now(),
            lastPreview: String(previewSnippet ?? "").slice(0, 200),
          },
          channels: [profileChannel.value],
        },
        session.value,
      );
    } catch {
      /* inbox index is best-effort */
    }
  }

  watch(
    () => [route.name, dmPeerActor.value, session.value?.actor],
    ([name, peer, self]) => {
      if (name === "dm" && peer && self && peer !== self) {
        void recordDmThread(peer, "");
      }
    },
  );

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

  const messageThreadActive = computed(
    () =>
      activeClubChannel.value != null ||
      (route.name === "dm" && dmPeerActor.value != null && !dmSelfConversation.value),
  );

  const isMessageThreadLoading = computed(
    () => messageThreadActive.value && messagesLoading.value,
  );

  function dismissProfileError() {
    profileError.value = "";
  }

  function normalizeBookStatus(status) {
    if (status === "finished" || status === "dnf") return status;
    return "reading";
  }

  function parseDraftPage(value) {
    const parsed = parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function setBookPageDraft(url, value) {
    bookPageDrafts.value = {
      ...bookPageDrafts.value,
      [url]: value == null || value === "" ? "" : String(value),
    };
  }

  function ensureBookPageDraft(entry) {
    if (!entry?.url) return;
    if (Object.prototype.hasOwnProperty.call(bookPageDrafts.value, entry.url)) return;
    setBookPageDraft(entry.url, entry.value?.currentPage ?? "");
  }

  async function replaceCurrentlyReadingEntry(entry, patch = {}) {
    if (!session.value || entry.actor !== session.value.actor) return;
    profileError.value = "";
    const pending = new Set(isUpdatingBook.value);
    pending.add(entry.url);
    isUpdatingBook.value = pending;
    try {
      const currentPageInput =
        patch.currentPage ?? parseDraftPage(bookPageDrafts.value[entry.url] ?? entry.value?.currentPage);
      const totalPages =
        Number.isFinite(entry.value?.totalPages) && entry.value.totalPages >= 0
          ? entry.value.totalPages
          : null;
      if (currentPageInput != null && currentPageInput < 0) {
        profileError.value = "Current page cannot be negative.";
        return;
      }
      if (
        currentPageInput != null &&
        Number.isFinite(totalPages) &&
        totalPages > 0 &&
        currentPageInput > totalPages
      ) {
        profileError.value = "Current page cannot be greater than total pages.";
        return;
      }
      const nextStatus = normalizeBookStatus(patch.status ?? entry.value?.status);
      const nextValue = {
        type: "CurrentlyReading",
        title: String(entry.value?.title ?? "").trim(),
        published: Date.now(),
        status: nextStatus,
        statusUpdatedAt: Date.now(),
      };
      const isbn = String(entry.value?.isbn ?? "").trim();
      if (isbn) nextValue.isbn = isbn;
      if (currentPageInput != null) nextValue.currentPage = currentPageInput;
      if (Number.isFinite(totalPages)) nextValue.totalPages = totalPages;

      await graffiti.post(
        {
          value: nextValue,
          channels: [profileChannel.value],
        },
        session.value,
      );
      await graffiti.delete(entry, session.value);
      setBookPageDraft(entry.url, nextValue.currentPage ?? "");
    } catch (e) {
      profileError.value =
        e instanceof Error ? e.message : "Could not update this book on your profile.";
    } finally {
      const done = new Set(isUpdatingBook.value);
      done.delete(entry.url);
      isUpdatingBook.value = done;
    }
  }

  function updateCurrentPage(entry) {
    return replaceCurrentlyReadingEntry(entry);
  }

  function markBookFinished(entry) {
    const totalPages =
      Number.isFinite(entry.value?.totalPages) && entry.value.totalPages > 0 ? entry.value.totalPages : null;
    const patch = { status: "finished" };
    if (totalPages != null) patch.currentPage = totalPages;
    return replaceCurrentlyReadingEntry(entry, patch);
  }

  function markBookDnf(entry) {
    return replaceCurrentlyReadingEntry(entry, { status: "dnf" });
  }

  function markBookReading(entry) {
    return replaceCurrentlyReadingEntry(entry, { status: "reading" });
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
        status: "reading",
        statusUpdatedAt: Date.now(),
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
    const channel = selectedMessageChannel.value;
    if (!text || !session.value || !channel || channel === IDLE_MESSAGE_CHANNEL) return;
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
      if (route.name === "dm" && dmPeerActor.value) {
        await recordDmThread(dmPeerActor.value, text);
      }
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
    activeClubChannel,
    dmPeerActor,
    dmPeerInvalid,
    readerProfilePeerActor,
    readerProfileInvalid,
    readerProfileDiscoverChannel,
    readerProfilePollLoading,
    readerCurrentlyReading,
    readerBooksByStatus,
    dmSelfConversation,
    dmInboxRows,
    newDmPeerInput,
    openNewDm,
    peerToKey,
    dmChannelPreview,
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
    myBooksByStatus,
    newBookTitle,
    newBookIsbn,
    newBookCurrentPage,
    newBookTotalPages,
    isAddingBook,
    profileError,
    isRemovingBook,
    isUpdatingBook,
    bookPageDrafts,
    normalizeBookStatus,
    splitBooksByStatus,
    ensureBookPageDraft,
    setBookPageDraft,
    addCurrentlyReadingBook,
    removeCurrentlyReadingBook,
    updateCurrentPage,
    markBookFinished,
    markBookDnf,
    markBookReading,
    dismissProfileError,
  };
}
