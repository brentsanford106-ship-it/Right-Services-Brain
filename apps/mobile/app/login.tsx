import React, { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ApiError, NetworkError, OwnerMismatchError } from "@rsb/photo-sync";
import { fetch as expoFetch } from "expo/fetch";
import { useApp, type PendingInvite, type SignInResult } from "../src/state";
import { entraConfig } from "../src/entra";
import { Button, C, DevBanner, Logo, s } from "../src/ui";

interface DevUser {
  subject: string;
  displayName: string;
  description: string;
}

/**
 * Sign-in screen.
 * - "Sign in" (shown once the EXPO_PUBLIC_ENTRA_* settings exist) opens Microsoft's real sign-in page.
 * - "Development sign-in" lets you pick a made-up test person. It is not secure and the server
 *   switches it off outside development.
 */
export default function Login() {
  const app = useApp();
  const [address, setAddress] = useState(app.server);
  useEffect(() => setAddress(app.server), [app.server]);
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<{ organizationId: string; organizationName: string }[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);

  const loadUsers = useCallback(async () => {
    setError(null);
    setUsers(null);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await expoFetch(`${app.server}/dev/auth/users`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`The server answered ${res.status}. Is development sign-in turned on?`);
      setUsers(((await res.json()) as { items: DevUser[] }).items);
    } catch (e) {
      setError(
        e instanceof Error && e.message.startsWith("The server")
          ? e.message
          : `Can't reach the server at ${app.server}. Check that the server is running on your PC and that the phone is on the same Wi-Fi.`,
      );
    }
  }, [app.server]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const real = entraConfig() !== null;

  const afterSignIn = async (r: SignInResult) => {
    const list = r.orgs;
    if (r.invites.length > 0) {
      // A company added this person: show it with Accept / Decline before anything else.
      setInvites(r.invites);
      setOrgs(list);
      return;
    }
    setInvites([]);
    if (list.length === 0) {
      setOrgs(null);
      setError("You're not in a company yet. Ask an owner to add your email address.");
    } else if (list.length === 1) {
      await app.chooseOrg(list[0]!.organizationId, list[0]!.organizationName);
      router.replace("/home");
    } else {
      setOrgs(list);
    }
  };

  const showError = (e: unknown) => {
    if (e instanceof OwnerMismatchError) {
      Alert.alert("Photos still waiting to upload", `${e.message} Sign in as ${e.owner.displayName} so they can finish uploading.`, [
        { text: "OK", style: "cancel" },
        {
          text: `Delete ${e.owner.displayName}'s photos`,
          style: "destructive",
          onPress: () =>
            Alert.alert("Delete them for good?", `${e.owner.displayName}'s photos that haven't been sent will be deleted from this phone. They can't be recovered.`, [
              { text: "Keep them", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => void app.signOut() },
            ]),
        },
      ]);
    } else if (e instanceof ApiError) setError(e.message);
    else if (e instanceof NetworkError) setError("No connection to the server. Signing in needs a connection the first time.");
    else setError(e instanceof Error ? e.message : "Sign-in failed.");
  };

  const signInReal = async () => {
    setBusy("real");
    setError(null);
    try {
      const r = await app.signInReal();
      if (!r) return; // closed the Microsoft page
      await afterSignIn(r);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const pick = async (u: DevUser) => {
    setBusy(u.subject);
    setError(null);
    try {
      await afterSignIn(await app.signIn(u.subject, u.displayName));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const chooseOrg = async (id: string, name: string) => {
    setBusy(id);
    try {
      await app.chooseOrg(id, name);
      router.replace("/home");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open that company.");
    } finally {
      setBusy(null);
    }
  };

  const respond = async (inv: PendingInvite, accept: boolean) => {
    setBusy(inv.inviteId + (accept ? ":a" : ":d"));
    setError(null);
    try {
      const r = await app.respondToInvite(inv.inviteId, accept);
      await afterSignIn(r);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  if (invites.length > 0) {
    return (
      <View style={s.screen}>
        <DevBanner />
        <View style={{ padding: 16 }}>
          <Text style={s.h1}>You've been added</Text>
          <Text style={[s.muted, { marginTop: 6 }]}>Join only companies you work for. You can't see anything of a company until you accept.</Text>
          {invites.map((inv) => (
            <View key={inv.inviteId} style={[s.card, { marginTop: 14 }]}>
              <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>{inv.organizationName}</Text>
              <Text style={[s.muted, { marginTop: 4 }]}>
                Added by {inv.invitedBy} as {inv.roles.join(", ") || "a member"}. Accept by {new Date(inv.expiresAt).toLocaleDateString()}.
              </Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                <Button title="Accept" busy={busy === inv.inviteId + ":a"} disabled={!!busy} style={{ flex: 1 }} onPress={() => void respond(inv, true)} />
                <Button
                  title="Decline"
                  kind="secondary"
                  busy={busy === inv.inviteId + ":d"}
                  disabled={!!busy}
                  style={{ flex: 1 }}
                  onPress={() =>
                    Alert.alert(`Decline ${inv.organizationName}?`, "You won't join this company. An owner would have to add you again.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Decline", style: "destructive", onPress: () => void respond(inv, false) },
                    ])
                  }
                />
              </View>
            </View>
          ))}
          {orgs && orgs.length > 0 ? (
            <Button kind="secondary" title="Not now, open my company" disabled={!!busy} style={{ marginTop: 18 }} onPress={() => { setInvites([]); void afterSignIn({ orgs, invites: [] }); }} />
          ) : null}
          {error ? <Text style={[s.error, { marginTop: 12 }]}>{error}</Text> : null}
        </View>
      </View>
    );
  }

  if (orgs) {
    return (
      <View style={s.screen}>
        <DevBanner />
        <View style={{ padding: 16 }}>
          <Text style={s.h1}>Choose a company</Text>
          {orgs.map((o) => (
            <Button key={o.organizationId} kind="secondary" title={o.organizationName} busy={busy === o.organizationId} style={{ marginTop: 12 }} onPress={() => void chooseOrg(o.organizationId, o.organizationName)} />
          ))}
          {error ? <Text style={[s.error, { marginTop: 12 }]}>{error}</Text> : null}
        </View>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <DevBanner />
      <FlatList
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        ListHeaderComponent={
          <View>
            <View style={{ alignItems: "center", backgroundColor: "#fff", borderRadius: 14, paddingVertical: 14, marginBottom: 20 }}>
              <Logo height={72} />
            </View>
            {app.notice ? <Text style={[s.muted, { marginBottom: 12 }]}>{app.notice}</Text> : null}
            {real ? (
              <View style={{ marginBottom: 28 }}>
                <Text style={s.h1}>Sign in</Text>
                <Text style={[s.muted, { marginTop: 6 }]}>Use the email address your company owner added. Microsoft will send you a code.</Text>
                <Button title="Sign in" busy={busy === "real"} disabled={!!busy} style={{ marginTop: 14 }} onPress={() => void signInReal()} />
              </View>
            ) : null}
            <Text style={s.h1}>Development sign-in</Text>
            <Text style={[s.muted, { marginTop: 6 }]}>Pick a made-up test person. This is only for testing and is not secure.</Text>
            <Text style={[s.label, { marginTop: 18 }]}>Server address (your PC)</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput
                style={[s.input, { flex: 1 }]}
                value={address}
                onChangeText={setAddress}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.1.20:4000" placeholderTextColor={C.muted}
              />
              <Button
                kind="secondary"
                title="Connect"
                onPress={() => {
                  app.setServer(address).catch((e: Error) => setError(e.message));
                }}
              />
            </View>
            {error ? <Text style={[s.error, { marginTop: 12 }]}>{error}</Text> : null}
            {!users && !error ? <Text style={[s.muted, { marginTop: 12 }]}>Connecting…</Text> : null}
            {users ? <Text style={[s.label, { marginTop: 20 }]}>Test people</Text> : null}
          </View>
        }
        data={users ?? []}
        keyExtractor={(u) => u.subject}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => void pick(item)}
            disabled={!!busy}
            style={({ pressed }) => [s.card, { marginBottom: 10, opacity: pressed || busy === item.subject ? 0.6 : 1 }]}
          >
            <Text style={{ fontSize: 16, fontWeight: "600", color: C.text }}>{item.displayName}</Text>
            <Text style={[s.muted, { marginTop: 2 }]}>{item.description}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
