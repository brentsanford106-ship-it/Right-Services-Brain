import React, { useEffect, useState } from "react";
import { Image as RNImage, Text, View, type ImageStyle, type StyleProp } from "react-native";
import { Image } from "expo-image";
import { initials, personColor, syncStateOf, type PhotoQueue, type QueuedPhoto, type Stage, type SyncState } from "@rsb/photo-sync";
import { useApp } from "./state";
import { C } from "./ui";

/** A photo as the server describes it. */
export interface ServerPhoto {
  id: string;
  jobId: string;
  jobNumber: string;
  stage: Stage | "issue" | "other";
  note: string | null;
  flagged: boolean;
  capturedAt: string;
  uploadStatus: "pending" | "stored" | "rejected";
  uploadedBy: string;
  /** Who took it. null = unknown (an imported photo). Missing on copies saved by older app versions. */
  photographerId?: string | null;
  photographer?: string | null;
  takenByMe?: boolean;
  uploadedByMe?: boolean;
  captureSource?: "in_app_camera" | "imported" | "web_upload";
  hasPreview: boolean;
  /** Server's answer to "may I delete this?" (for hiding buttons; the server still checks). */
  canDelete?: boolean;
  latitude: number | null;
  longitude: number | null;
}

/** One tile in a gallery: either a photo on this phone, a photo on the server, or both. */
export interface GalleryItem {
  key: string; // "l:<localId>" or "s:<serverId>"
  capturedAt: string;
  stage: string;
  flagged: boolean;
  note: string | null;
  state: SyncState | "server" | "server_missing_file";
  local: QueuedPhoto | null;
  server: ServerPhoto | null;
  /** Who took it: "me", a person's id, or "unknown" (for the People filter). */
  personKey: string;
  /** Their name; null when unknown. */
  personName: string | null;
}

/** Who took a photo, from the phone's point of view. Photos still only on this phone are always mine. */
function who(sp: ServerPhoto | null, myName: string): { personKey: string; personName: string | null } {
  if (!sp) return { personKey: "me", personName: myName };
  // Older cached copies have no photographer fields: until then every photo was taken in the app by its uploader.
  const mine = sp.takenByMe ?? sp.uploadedBy === myName;
  if (mine) return { personKey: "me", personName: sp.photographer ?? myName };
  if (sp.photographerId === undefined) return { personKey: `name:${sp.uploadedBy}`, personName: sp.uploadedBy };
  if (sp.photographerId === null) return { personKey: "unknown", personName: null };
  return { personKey: sp.photographerId, personName: sp.photographer ?? null };
}

export type Filter = "all" | Stage | "flagged";

export function mergeGallery(queue: PhotoQueue, jobId: string, server: ServerPhoto[], uploadingId: string | null, myName = ""): GalleryItem[] {
  const out: GalleryItem[] = [];
  const localByServer = new Map<string, QueuedPhoto>();
  for (const p of queue.forJob(jobId)) {
    if (p.serverId) localByServer.set(p.serverId, p);
    if (p.remoteOnly) continue; // shown via its server entry, with local edits applied below
    const sp = p.serverId ? server.find((x) => x.id === p.serverId) ?? null : null;
    out.push({ key: `l:${p.localId}`, capturedAt: p.capturedAt, stage: p.stage, flagged: p.flagged, note: p.note, state: syncStateOf(p, uploadingId), local: p, server: sp, ...who(sp, myName) });
  }
  for (const sp of server) {
    const lp = localByServer.get(sp.id);
    if (lp && !lp.remoteOnly) continue;
    out.push({
      key: `s:${sp.id}`,
      capturedAt: sp.capturedAt,
      stage: lp?.stage ?? sp.stage,
      flagged: lp?.flagged ?? sp.flagged,
      note: lp ? lp.note : sp.note,
      state: lp ? syncStateOf(lp, uploadingId) : sp.uploadStatus === "stored" ? "server" : "server_missing_file",
      local: lp ?? null,
      server: sp,
      ...who(sp, myName),
    });
  }
  return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function applyFilter(items: GalleryItem[], f: Filter): GalleryItem[] {
  if (f === "all") return items;
  if (f === "flagged") return items.filter((i) => i.flagged);
  return items.filter((i) => i.stage === f);
}

/** Thumbnail of a photo stored (encrypted) on this phone. Decrypted in memory only. */
export function LocalImage({ localId, which, style }: { localId: string; which: "thumbnail" | "original"; style: StyleProp<ImageStyle> }) {
  const { queue } = useApp();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let b64 = await queue.imageBase64(localId, which);
        if (!b64 && which === "original") b64 = await queue.imageBase64(localId, "thumbnail");
        if (live && b64) setUri(`data:image/jpeg;base64,${b64}`);
      } catch {
        if (live) setUri(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [localId, which, queue]);
  if (!uri) return <View style={[style as object, { backgroundColor: C.line }]} />;
  return <RNImage source={{ uri }} style={style} resizeMode={which === "original" ? "contain" : "cover"} />;
}

/**
 * Image from the server. Every request carries the access token (there are no shareable links).
 * Cached in memory only, so server images are not written to the phone's disk.
 */
export function ServerImage({ photoId, style, contain, thumb }: { photoId: string; style: StyleProp<ImageStyle>; contain?: boolean; thumb?: boolean }) {
  const app = useApp();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    void app.token().then(setToken);
  }, [app]);
  if (!token) return <View style={[style as object, { backgroundColor: C.line }]} />;
  return (
    <Image
      source={{ uri: `${app.server}/v1/orgs/${app.session!.orgId}/photos/${photoId}/content${thumb ? "?variant=thumb" : ""}`, headers: { Authorization: `Bearer ${token}` } }}
      style={style}
      contentFit={contain ? "contain" : "cover"}
      cachePolicy="memory"
      transition={150}
    />
  );
}

/** Small colored circle with someone's initials (there are no profile pictures yet). */
export function PersonBadge({ personKey, name, size = 22 }: { personKey: string; name: string | null; size?: number }) {
  return (
    <View
      accessibilityLabel={name ? `Taken by ${name}` : "Who took this is unknown"}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: personColor(personKey === "unknown" ? null : personKey), alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: "rgba(255,255,255,0.9)" }}
    >
      <Text style={{ color: "#fff", fontWeight: "800", fontSize: Math.round(size * 0.42) }}>{initials(name)}</Text>
    </View>
  );
}
