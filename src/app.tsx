type QueueTrack = {provider: string, contextTrack?: Spicetify.ContextTrack};

type LastInsertedTrack = {
  uri: string;
};

const LAST_INSERTED_KEY = "add-to-queue-after:last-inserted";

async function main() {
  while (!(Spicetify?.CosmosAsync && Spicetify?.Queue && Spicetify?.ContextMenu && Spicetify?.URI && Spicetify?.Platform && Spicetify?.GraphQL && Spicetify?.Locale)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  function getQueue(): QueueTrack[] {
    return Spicetify.Queue.nextTracks.filter((queuedTrack: QueueTrack) => {
      if (queuedTrack?.provider === "queue") return true;
      const meta = queuedTrack?.contextTrack?.metadata;
      return meta?.is_queued === "true";
    });
  }

  function shouldAddToMenu(uris: string[]): boolean {
    if (uris.length > 1) {
      return true;
    }
    const uriObj = Spicetify.URI.fromString(uris[0]);
    switch (uriObj.type) {
      case Spicetify.URI.Type.TRACK:
      case Spicetify.URI.Type.PLAYLIST:
      case Spicetify.URI.Type.PLAYLIST_V2:
      case Spicetify.URI.Type.ALBUM:
      case Spicetify.URI.Type.LOCAL:
        return true;
    }
    return false;
  }

  async function fetchAlbum(uri: string): Promise<string[]> {
    const { getAlbumNameAndTracks } = Spicetify.GraphQL.Definitions;
    const { errors, data } = await Spicetify.GraphQL.Request(getAlbumNameAndTracks, {
      uri,
      locale: Spicetify.Locale.getLocale(),
      offset: 0,
      limit: 50,
    });

    if (errors) throw new Error("No album info returned.");
    return data.albumUnion.tracksV2.items.map((item: { track: Spicetify.PlayerTrack }) => item.track.uri);
  }

  async function fetchPlaylist(uri: string): Promise<string[]> {
    const res = await Spicetify.Platform.PlaylistAPI.getContents(uri, {limit: 9999999999})
    return res.items.map((item: Spicetify.PlayerTrack) => item.uri);
  }

  async function fetchTracksFromUri(uris: string[]): Promise<string[]> {
    const uri = uris[0];
    const uriObj = Spicetify.URI.fromString(uri);
    
    if (uris.length > 1 || uriObj.type === Spicetify.URI.Type.TRACK || uriObj.type === Spicetify.URI.Type.LOCAL) {
      return uris;
    }

    let tracks: string[] = [];
    switch (uriObj.type) {
      case Spicetify.URI.Type.PLAYLIST:
      case Spicetify.URI.Type.PLAYLIST_V2:
        tracks = await fetchPlaylist(uri);
        break;
      case Spicetify.URI.Type.ALBUM:
        tracks = await fetchAlbum(uri);
        break;
    }

    return tracks;
  }

  function getTrackDisplayName(track: QueueTrack, index: number): string {
    if (!track) return `Track ${index + 1}`;
    
    const trackName = track.contextTrack?.metadata?.title || "Unknown Track";
    const artistName = track.contextTrack?.metadata?.artist_name;
    
    return artistName ? `${trackName} - ${artistName}` : trackName;
  }

  const FALLBACK_ICON = "album";
  const LOCAL_COVER_TIMEOUT_MS = 3000;
  const coverCache = new Map<string, string>();
  const coverPromises = new Map<string, Promise<string | undefined>>();
  let localFileImages: Map<string, string> | undefined;
  let localFileImagesPromise: Promise<Map<string, string>> | undefined;

  function isLocalTrackUri(uri?: string): boolean {
    return !!uri?.startsWith("spotify:local");
  }

  function isHttpUrl(url: string): boolean {
    return url.startsWith("https://") || url.startsWith("http://") || url.startsWith("data:");
  }

  function coverSvg(url: string): string {
    const safe = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    return `<image href="${safe}" width="16" height="16" preserveAspectRatio="xMidYMid slice"/>`;
  }

  function toCoverUrl(raw?: string): string | undefined {
    if (!raw) return undefined;
    if (isHttpUrl(raw) || raw.startsWith("spotify:")) return raw;
    return undefined;
  }

  function cdnCoverUrl(raw?: string): string | undefined {
    const url = toCoverUrl(raw);
    if (!url) return undefined;
    if (url.startsWith("spotify:image:")) {
      const id = url.slice("spotify:image:".length);
      if (/^[a-f0-9]+$/i.test(id)) return `https://i.scdn.co/image/${id}`;
      return undefined;
    }
    if (isHttpUrl(url) && !url.startsWith("spotify:")) return url;
    return undefined;
  }

  function localCoverCandidates(track: QueueTrack): string[] {
    const uri = track.contextTrack?.uri;
    const meta = track.contextTrack?.metadata;
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const raw of [
      uri ? localFileImages?.get(uri) : undefined,
      meta?.image_small_url,
      meta?.image_url,
      meta?.image_large_url,
      uri,
    ]) {
      const url = toCoverUrl(raw);
      if (!url || seen.has(url) || url.startsWith("https://i.scdn.co/")) continue;
      seen.add(url);
      candidates.push(url);
    }
    return candidates;
  }

  async function ensureLocalFileImages(): Promise<Map<string, string>> {
    if (localFileImages) return localFileImages;
    if (!localFileImagesPromise) {
      localFileImagesPromise = (async () => {
        const images = new Map<string, string>();
        try {
          const tracks = await Spicetify.Platform.LocalFilesAPI.getTracks() as {
            uri: string;
            album?: { images?: { url: string }[] };
          }[];
          for (const localTrack of tracks) {
            const url = localTrack.album?.images?.[0]?.url;
            if (localTrack.uri && url) images.set(localTrack.uri, url);
          }
        } catch {
          // LocalFilesAPI is missing on some Spotify builds
        }
        localFileImages = images;
        return images;
      })();
    }
    return localFileImagesPromise;
  }

  // Rasterize spotify:local: art the same way Spicy Lyrics does: HTML Image can
  // decode the client protocol, SVG <image> inside context-menu icons cannot.
  async function rasterizeLocalCover(coverUrl: string): Promise<string | undefined> {
    const img = new Image();
    img.src = coverUrl;
    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        img.decode(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("decode timed out")), LOCAL_COVER_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timeoutId));
    } catch {
      return undefined;
    }

    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx || !img.naturalWidth) return undefined;
    ctx.drawImage(img, 0, 0, size, size);
    try {
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      return undefined;
    }
  }

  async function resolveLocalCover(track: QueueTrack): Promise<string | undefined> {
    const uri = track.contextTrack?.uri;
    if (!isLocalTrackUri(uri) || !uri) return undefined;
    const cached = coverCache.get(uri);
    if (cached) return cached;

    const inflight = coverPromises.get(uri);
    if (inflight) return inflight;

    const promise = (async () => {
      await ensureLocalFileImages();
      for (const source of localCoverCandidates(track)) {
        const dataUrl = source.startsWith("data:") ? source : await rasterizeLocalCover(source);
        if (dataUrl) {
          coverCache.set(uri, dataUrl);
          return dataUrl;
        }
      }
      return undefined;
    })();

    coverPromises.set(uri, promise);
    void promise.then((url) => {
      if (!url) coverPromises.delete(uri);
    });
    return promise;
  }

  function getTrackIcon(track: QueueTrack): string {
    const uri = track.contextTrack?.uri;
    if (uri && coverCache.has(uri)) return coverSvg(coverCache.get(uri)!);

    if (!isLocalTrackUri(uri)) {
      const meta = track.contextTrack?.metadata;
      const url = cdnCoverUrl(meta?.image_small_url || meta?.image_url || meta?.image_large_url);
      if (url) return coverSvg(url);
    }

    return FALLBACK_ICON;
  }

  function setItemCover(item: Spicetify.ContextMenu.Item, track: QueueTrack) {
    item.icon = getTrackIcon(track);
    void resolveLocalCover(track).then((url) => {
      if (url) item.icon = coverSvg(url);
    });
  }

  function getLastInserted(): LastInsertedTrack | null {
    const raw = Spicetify.LocalStorage.get(LAST_INSERTED_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LastInsertedTrack;
    } catch {
      return null;
    }
  }

  function saveLastInserted(tracksToAdd: string[]) {
    if (tracksToAdd.length === 0) return;
    const lastInserted: LastInsertedTrack = { uri: tracksToAdd[tracksToAdd.length - 1] };
    Spicetify.LocalStorage.set(LAST_INSERTED_KEY, JSON.stringify(lastInserted));
  }

  function findTrackPosition(uri: string): number {
    const queue = getQueue();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].contextTrack?.uri === uri) {
        return i;
      }
    }
    return -1;
  }

  async function insertAfterPosition(tracksToAdd: string[], position: number): Promise<boolean> {
    try {
      const uriObjects = tracksToAdd.map((uri: string) => ({ uri }));
      const queue = getQueue();

      if (!queue || queue.length === 0) {
        await Spicetify.addToQueue(uriObjects);
        Spicetify.showNotification("Added to queue");
        saveLastInserted(tracksToAdd);
        return true;
      }

      if (position >= queue.length - 1) {
        await Spicetify.addToQueue(uriObjects);
        Spicetify.showNotification("Added to end of queue");
        saveLastInserted(tracksToAdd);
        return true;
      }

      const nextTrack = queue[position + 1];
      const beforeTrack = {
        uri: nextTrack.contextTrack?.uri,
        uid: nextTrack.contextTrack?.uid,
      };

      await Spicetify.Platform.PlayerAPI.insertIntoQueue(uriObjects, {
        before: beforeTrack,
      });
      Spicetify.showNotification(`Added after "${getTrackDisplayName(queue[position], position)}"`);
      saveLastInserted(tracksToAdd);
      return true;
    } catch (err) {
      console.error("Failed to insert into queue", err);
      Spicetify.showNotification("Unable to add to queue. Check console.", true);
      return false;
    }
  }

  // Store pending URIs for the submenu items
  let pendingUris: string[] = [];

  // Spotify's max queue size is 80
  const MAX_QUEUE_ITEMS = 80;
  const submenuItems: Spicetify.ContextMenu.Item[] = [];

  const afterLastInsertedItem = new Spicetify.ContextMenu.Item(
    "After last inserted",
    async () => {
      try {
        const lastInserted = getLastInserted();
        if (!lastInserted) return;

        const position = findTrackPosition(lastInserted.uri);
        if (position < 0) {
          Spicetify.showNotification("Last inserted track is no longer in the queue", true);
          return;
        }

        const tracksToAdd = await fetchTracksFromUri(pendingUris);
        await insertAfterPosition(tracksToAdd, position);
      } catch (err) {
        console.error("Failed to add tracks", err);
        Spicetify.showNotification("Failed to add tracks. Check console.", true);
      }
    },
    () => {
      const lastInserted = getLastInserted();
      if (!lastInserted) return false;

      const position = findTrackPosition(lastInserted.uri);
      if (position < 0) return false;

      const queue = getQueue();
      afterLastInsertedItem.name = `After last inserted: ${getTrackDisplayName(queue[position], position)}`;
      setItemCover(afterLastInsertedItem, queue[position]);
      return true;
    },
    undefined,
    false
  );

  submenuItems.push(afterLastInsertedItem);

  for (let i = 0; i < MAX_QUEUE_ITEMS; i++) {
    const position = i;
    
    const menuItem = new Spicetify.ContextMenu.Item(
      `Position ${i + 1}`, // Default name, will be overridden
      async () => {
        try {
          const tracksToAdd = await fetchTracksFromUri(pendingUris);
          await insertAfterPosition(tracksToAdd, position);
        } catch (err) {
          console.error("Failed to add tracks", err);
          Spicetify.showNotification("Failed to add tracks. Check console.", true);
        }
      },
      () => {
        // Only show this item if queue has enough tracks
        const queue = getQueue();
        if (!queue || position >= queue.length) {
          return false;
        }
        // Update the item name and cover with current track info
        menuItem.name = getTrackDisplayName(queue[position], position);
        setItemCover(menuItem, queue[position]);
        return true;
      },
      undefined,
      false
    );
    
    submenuItems.push(menuItem);
  }

  const submenu = new Spicetify.ContextMenu.SubMenu(
    "Add to Queue After...",
    submenuItems,
    (uris: string[]) => {
      if (!shouldAddToMenu(uris)) {
        return false;
      }

      pendingUris = uris;

      // Don't show if queue is empty
      const queue = getQueue();
      if (!queue || queue.length === 0) return false;
      for (const track of queue) void resolveLocalCover(track);
      return true;
    },
    false,
    "queue",
  );

  submenu.register();
}

export default main;
