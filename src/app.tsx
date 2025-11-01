type QueueTrack = {provider: string, contextTrack?: Spicetify.ContextTrack};

async function main() {
  while (!(Spicetify?.CosmosAsync && Spicetify?.Queue && Spicetify?.ContextMenu && Spicetify?.URI && Spicetify?.Platform)) {
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
    const albumId = uri.split(":")[2];
    const res = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/albums/${albumId}`);
    return res.tracks.items.map((item: Spicetify.PlayerTrack) => item.uri);
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

  async function insertAfterPosition(tracksToAdd: string[], position: number) {
    try {
      const uriObjects = tracksToAdd.map((uri: string) => ({ uri }));
      const queue = getQueue();

      if (!queue || queue.length === 0) {
        // Queue is empty, just add to queue
        await Spicetify.addToQueue(uriObjects);
        Spicetify.showNotification("Added to queue");
        return;
      }

      if (position >= queue.length - 1) {
        // Adding after the last track, use addToQueue
        await Spicetify.addToQueue(uriObjects);
        Spicetify.showNotification("Added to end of queue");
        return;
      }

      // Insert before the next track (which means after current position)
      const nextTrack = queue[position + 1];
      const beforeTrack = {
        uri: nextTrack.contextTrack?.uri,
        uid: nextTrack.contextTrack?.uid,
      };

      await Spicetify.Platform.PlayerAPI.insertIntoQueue(uriObjects, {
        before: beforeTrack,
      });
      Spicetify.showNotification(`Added after "${getTrackDisplayName(queue[position], position)}"`);
    } catch (err) {
      console.error("Failed to insert into queue", err);
      Spicetify.showNotification("Unable to add to queue. Check console.", true);
    }
  }

  // Store pending URIs for the submenu items
  let pendingUris: string[] = [];

  // Spotify's max queue size is 80
  const MAX_QUEUE_ITEMS = 80;
  const submenuItems: Spicetify.ContextMenu.Item[] = [];

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
        // Update the item name with current track info
        menuItem.name = getTrackDisplayName(queue[position], position);
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
      return queue && queue.length > 0;
    },
    false
  );

  submenu.register();
}

export default main;
