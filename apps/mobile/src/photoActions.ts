import { Alert } from "react-native";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { ApiError, NetworkError } from "@rsb/photo-sync";
import type { useApp } from "./state";

type AppState = ReturnType<typeof useApp>;
import type { GalleryItem } from "./photos";
import { deleteQuietly, scratchDir } from "./platform";

/** The server id of a gallery item, if the server has a record of it. */
export const serverIdOf = (i: GalleryItem): string | null => i.server?.id ?? i.local?.serverId ?? null;

/** Photos still only on this phone are the photographer's own; server photos say whether we may delete them. */
export const canDeleteItem = (i: GalleryItem): boolean => (i.server ? i.server.canDelete !== false : true);

/** Whether a photo's file is on the server, so it can be shared. */
const isShareable = (i: GalleryItem): boolean =>
  !!serverIdOf(i) && (i.server ? i.server.uploadStatus === "stored" : !!i.local?.stored);

/**
 * Asks, then deletes. Uploaded photos are hidden on the server (an owner or manager can restore them
 * from the website). Photos that never reached the server are removed from this phone for good.
 * Calls `done` with how many were deleted.
 */
export function confirmDelete(app: AppState, items: GalleryItem[], done: (deleted: number) => void): void {
  const allowed = items.filter(canDeleteItem);
  const blocked = items.length - allowed.length;
  if (!allowed.length) {
    Alert.alert("Can't delete", "You can only delete photos you took. Ask an owner or manager to delete the others.");
    return;
  }
  const notUploaded = allowed.filter((i) => !serverIdOf(i)).length;
  const n = allowed.length;
  const lines: string[] = [];
  if (notUploaded === n) lines.push(n === 1 ? "This photo hasn't uploaded yet, so it will be gone for good." : "These photos haven't uploaded yet, so they will be gone for good.");
  else if (notUploaded) lines.push(`${notUploaded} of them haven't uploaded yet and will be gone for good. The rest can be restored by an owner or manager on the website.`);
  else lines.push("An owner or manager can restore deleted photos on the website.");
  if (blocked) lines.push(`${blocked} selected photo${blocked > 1 ? "s were" : " was"} taken by someone else and will be kept.`);
  Alert.alert(`Delete ${n} photo${n > 1 ? "s" : ""}?`, lines.join("\n\n"), [
    { text: "Cancel", style: "cancel" },
    { text: n > 1 ? `Delete ${n} Photos` : "Delete Photo", style: "destructive", onPress: () => void run() },
  ]);

  async function run() {
    let deleted = 0;
    let offline = 0;
    let failed = 0;
    for (const i of allowed) {
      try {
        const sid = serverIdOf(i);
        if (sid) {
          try {
            await app.api.delete(`/v1/orgs/${app.session!.orgId}/photos/${sid}`);
          } catch (e) {
            // Already deleted (for example by a retry or by the office) counts as done.
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
        }
        if (i.local) await app.queue.discard(i.local.localId);
        deleted++;
      } catch (e) {
        if (e instanceof NetworkError) offline++;
        else failed++;
      }
    }
    if (offline) Alert.alert("Some photos weren't deleted", `${offline} uploaded photo${offline > 1 ? "s need" : " needs"} a connection to delete. Try again when you have signal.`);
    else if (failed) Alert.alert("Some photos weren't deleted", `${failed} couldn't be deleted. Please try again.`);
    done(deleted);
  }
}

/**
 * Sends photos out of the app through the iPhone share sheet (Messages, Mail, AirDrop…).
 * Needs a connection: every share is recorded on the server first. The shared copy is the
 * display-size JPEG without location data; the temporary unencrypted copy is deleted right after.
 */
export async function sharePhotos(app: AppState, items: GalleryItem[], jobNumber: string): Promise<void> {
  const ready = items.filter(isShareable);
  if (!ready.length) {
    Alert.alert("Not uploaded yet", "Photos can be shared once they've finished uploading.");
    return;
  }
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert("Sharing isn't available on this device.");
    return;
  }
  const ids = ready.map((i) => serverIdOf(i)!);
  try {
    await app.api.post(`/v1/orgs/${app.session!.orgId}/photos/exports`, { photoIds: ids, channel: "share_sheet" });
  } catch (e) {
    Alert.alert(
      "Couldn't share",
      e instanceof NetworkError
        ? "Sharing needs a connection, because every shared photo is recorded. Try again when you have signal."
        : e instanceof ApiError && e.status === 403
          ? "Your company has turned off sending photos out of the app for your role."
          : e instanceof ApiError
          ? e.message
          : "Please try again.",
    );
    return;
  }
  const skipped = items.length - ready.length;
  const token = await app.api.accessToken();
  for (let n = 0; n < ids.length; n++) {
    const file = new File(scratchDir(), `RightServices-${jobNumber.replace(/[^A-Za-z0-9_-]/g, "")}-${n + 1}.jpg`);
    try {
      deleteQuietly(file.uri);
      await File.downloadFileAsync(`${app.api.baseUrl}/v1/orgs/${app.session!.orgId}/photos/${ids[n]}/content`, file, {
        headers: { authorization: `Bearer ${token}` },
      });
      // iPhone's share sheet takes one photo at a time here; it opens again for the next one.
      await Sharing.shareAsync(file.uri, { mimeType: "image/jpeg", UTI: "public.jpeg", dialogTitle: `Photo ${n + 1} of ${ids.length}` });
    } catch {
      Alert.alert("Couldn't share a photo", `Photo ${n + 1} of ${ids.length} couldn't be prepared. Check the connection and try again.`);
      break;
    } finally {
      deleteQuietly(file.uri);
    }
  }
  if (skipped) Alert.alert("Some photos weren't shared", `${skipped} photo${skipped > 1 ? "s haven't" : " hasn't"} finished uploading yet.`);
}
