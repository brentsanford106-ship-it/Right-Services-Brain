import { Alert, Linking } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import { ApiError, NetworkError, dateTakenFromExif, type Stage } from "@rsb/photo-sync";
import type { useApp } from "./state";
import { deleteQuietly } from "./platform";

type AppState = ReturnType<typeof useApp>;
const THUMB_WIDTH = 360;
const MAX_AT_ONCE = 30;

/** Asks for photo library access, explaining how to turn it on if it was refused before. */
async function libraryAllowed(): Promise<boolean> {
  const cur = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (cur.granted) return true;
  if (cur.canAskAgain) return (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted;
  Alert.alert("Photo access is off", "To add photos from your library, allow photo access for this app in Settings.", [
    { text: "Cancel", style: "cancel" },
    { text: "Open Settings", onPress: () => void Linking.openSettings() },
  ]);
  return false;
}

/**
 * Adds photos from the phone's library to a job. They are saved encrypted and uploaded exactly like camera photos,
 * but marked "Imported": who took them shows as unknown, no location is attached (the phone's current location
 * says nothing about where an old photo was taken), and the date comes from the photo's own details when it has one.
 * Returns how many were added.
 */
export async function importFromLibrary(app: AppState, job: { jobId: string; jobNumber: string }, stage: Stage): Promise<number> {
  if (!(await libraryAllowed())) return 0;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: MAX_AT_ONCE,
    exif: true,
    quality: 1,
    // iPhone photos are usually HEIC: ask iOS for a JPEG copy, which the server and every browser can show.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (res.canceled || !res.assets.length) return 0;
  let added = 0;
  let unknownDates = 0;
  const failed: string[] = [];
  for (const asset of res.assets) {
    let jpegUri: string | null = null;
    let thumbUri: string | null = null;
    try {
      const isJpeg = asset.mimeType === "image/jpeg" || /\.jpe?g$/i.test(asset.fileName ?? asset.uri);
      if (!isJpeg) {
        const ctx = ImageManipulator.manipulate(asset.uri);
        jpegUri = (await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.92 })).uri;
      }
      const t = ImageManipulator.manipulate(jpegUri ?? asset.uri);
      t.resize({ width: THUMB_WIDTH, height: null });
      thumbUri = (await (await t.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.7 })).uri;
      const [original, thumbnail] = await Promise.all([new File(jpegUri ?? asset.uri).bytes(), new File(thumbUri).bytes()]);
      const taken = dateTakenFromExif(asset.exif ?? null);
      if (!taken) unknownDates++;
      await app.queue.capture({
        orgId: app.session!.orgId,
        jobId: job.jobId,
        jobNumber: job.jobNumber,
        stage,
        capturedAt: taken ?? new Date().toISOString(),
        capturedAtKnown: taken !== null,
        captureSource: "imported",
        original,
        thumbnail,
        widthPx: asset.width || null,
        heightPx: asset.height || null,
        location: null,
      });
      added++;
    } catch (e) {
      failed.push(asset.fileName ?? `photo ${failed.length + added + 1}`);
      if (e instanceof ApiError || e instanceof NetworkError) break;
    } finally {
      // Unencrypted copies made by the photo picker and the converter: delete right away.
      deleteQuietly(asset.uri);
      deleteQuietly(jpegUri);
      deleteQuietly(thumbUri);
    }
  }
  if (added) app.syncNow();
  const notes: string[] = [];
  if (unknownDates) notes.push(`${unknownDates} had no "date taken", so they show the time you added them.`);
  if (failed.length) notes.push(`${failed.length} couldn't be added: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`);
  Alert.alert(
    added ? `Added ${added} photo${added === 1 ? "" : "s"}` : "No photos added",
    [`They're marked "Imported", and who took them shows as unknown.`, ...notes].join("\n\n"),
  );
  return added;
}

/** Profile picture: pick one from the library (square crop) or take a selfie, then upload it. Needs a connection. */
export async function chooseProfilePicture(app: AppState, from: "library" | "camera"): Promise<boolean> {
  if (from === "library" && !(await libraryAllowed())) return false;
  if (from === "camera") {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) {
      Alert.alert("Camera access is off", "Allow camera access for this app in Settings.");
      return false;
    }
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.9, exif: false };
  const res = from === "camera" ? await ImagePicker.launchCameraAsync({ ...opts, cameraType: ImagePicker.CameraType.front }) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets[0]) return false;
  const asset = res.assets[0];
  let small: string | null = null;
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    ctx.resize({ width: 512, height: null });
    small = (await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.85 })).uri;
    const bytes = await new File(small).bytes();
    const r = await app.api.putRaw<{ avatarAt: string }>(`/v1/orgs/${app.session!.orgId}/me/avatar`, bytes, "image/jpeg");
    await app.refreshPermissions();
    return !!r.avatarAt;
  } catch (e) {
    Alert.alert("Picture not saved", e instanceof NetworkError ? "Changing your picture needs a connection. Try again when you have signal." : e instanceof ApiError ? e.message : "Please try again.");
    return false;
  } finally {
    deleteQuietly(asset.uri);
    deleteQuietly(small);
  }
}
