import React, { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ApiError, NetworkError, OwnerMismatchError } from "@rsb/photo-sync";
import { fetch as expoFetch } from "expo/fetch";
import { useApp } from "../src/state";
import { Button, C, DevBanner, s } from "../src/ui";

interface DevUser {
  subject: string;
  displayName: string;
  description: string;
}

/**
 * DEVELOPMENT sign-in screen. It lets you pick a made-up test person. It is not secure and is
 * switched off on the server outside development. Real sign-in (Microsoft Entra External ID) replaces it.
 */
export default function Login() {
  const app = useApp();
  const [address, setAddress] = useState(app.server);
  useEffect(() => setAddress(app.server), [app.server]);
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<{ organizationId: string; organizationName: string }[] | null>(null);

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

  const pick = async (u: DevUser) => {
    setBusy(u.subject);
    setError(null);
    try {
      const { orgs: list } = await app.signIn(u.subject, u.displayName);
      if (list.length === 0) {
        setError(`${u.displayName} isn't an active member of any company.`);
      } else if (list.length === 1) {
        await app.chooseOrg(list[0]!.organizationId, list[0]!.organizationName);
        router.replace("/jobs");
      } else {
        setOrgs(list);
      }
    } catch (e) {
      if (e instanceof OwnerMismatchError) {
        Alert.alert("Photos still uploading", `${e.message} Sign in as ${e.owner.displayName} so they can finish uploading.`);
      } else if (e instanceof ApiError) setError(e.message);
      else if (e instanceof NetworkError) setError("No connection to the server. Signing in needs a connection the first time.");
      else setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(null);
    }
  };

  const chooseOrg = async (id: string, name: string) => {
    setBusy(id);
    try {
      await app.chooseOrg(id, name);
      router.replace("/jobs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open that company.");
    } finally {
      setBusy(null);
    }
  };

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
                placeholder="http://192.168.1.20:4000"
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
