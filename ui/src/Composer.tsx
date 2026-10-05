// Zone de saisie : répondre à la session choisie (ou la reprendre), ou en créer une.
// Les champs sont créés une seule fois et jamais reconstruits, pour ne pas perdre
// le texte en cours de frappe ni le focus quand l'état d'une session change.

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { createComputed, createState } from "gnim";
import type { ErrorCode } from "../../shared/protocol.ts";
import { createSession, isClosed, sendToSession, stopSession } from "./actions.ts";
import { claimKeyboardOnClick } from "./keyboard.ts";
import { composing, lastError, selectedId, sessions, setComposing } from "./store.ts";

const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid_message: "Message refusé par le daemon.",
  unknown_session: "Session inconnue.",
  session_closed: "La session est terminée.",
  invalid_cwd: "Dossier introuvable.",
  not_resumable: "Cette session ne peut pas être reprise.",
  history_unavailable: "Historique indisponible.",
  internal: "Erreur interne du daemon.",
};

const [formError, setFormError] = createState<string | null>(null);

const selectedSession = createComputed(() => {
  const id = selectedId();
  return sessions().find((s) => s.id === id) ?? null;
});

function report(error: string | null): boolean {
  setFormError(error);
  return error === null;
}

function NewSessionForm() {
  let folder: Gtk.Entry;
  let name: Gtk.Entry;
  let prompt: Gtk.Entry;

  const submit = () => {
    if (report(createSession(folder.text, prompt.text, name.text))) {
      prompt.text = "";
      name.text = "";
      setComposing(false);
    }
  };

  const browse = () => {
    const dialog = new Gtk.FileDialog({ title: "Dossier de la session", modal: false });
    const current = folder.text.trim();
    if (current.startsWith("/")) dialog.set_initial_folder(Gio.File.new_for_path(current));
    dialog.select_folder(null, null, (_src, res) => {
      try {
        const path = dialog.select_folder_finish(res)?.get_path();
        if (path) folder.text = path;
      } catch {
        // dialogue annulé
      }
    });
  };

  return (
    <Gtk.Box class="new-session" orientation={Gtk.Orientation.VERTICAL} spacing={6} visible={composing}>
      <Gtk.Box spacing={6}>
        <Gtk.Entry
          hexpand
          placeholderText="Dossier"
          text={GLib.get_home_dir()}
          $={(self) => {
            folder = self;
            claimKeyboardOnClick(self);
          }}
        />
        <Gtk.Button label="…" tooltipText="Choisir un dossier" onClicked={browse} />
      </Gtk.Box>
      <Gtk.Entry
        placeholderText="Nom (facultatif)"
        maxLength={200}
        $={(self) => {
          name = self;
          claimKeyboardOnClick(self);
        }}
      />
      <Gtk.Entry
        placeholderText="Premier message"
        onActivate={submit}
        $={(self) => {
          prompt = self;
          claimKeyboardOnClick(self);
        }}
      />
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Annuler" onClicked={() => setComposing(false)} />
        <Gtk.Button class="suggested" label="Créer" onClicked={submit} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

function ReplyBox() {
  let entry: Gtk.Entry;

  const submit = () => {
    const session = selectedSession.peek();
    if (session === null) return;
    if (report(sendToSession(session, entry.text))) entry.text = "";
  };

  const placeholder = selectedSession((s) => {
    if (s === null) return "Aucune session sélectionnée";
    if (!isClosed(s)) return "Répondre…";
    return s.claudeSessionId === null ? "Session impossible à reprendre" : "Reprendre la session…";
  });
  const canSend = selectedSession((s) => s !== null && (!isClosed(s) || s.claudeSessionId !== null));
  const canStop = selectedSession((s) => s !== null && !isClosed(s));

  return (
    <Gtk.Box class="reply" spacing={6} visible={composing((c) => !c)}>
      <Gtk.Entry
        hexpand
        placeholderText={placeholder}
        sensitive={canSend}
        onActivate={submit}
        $={(self) => {
          entry = self;
          claimKeyboardOnClick(self);
        }}
      />
      <Gtk.Button
        class="stop"
        label="Arrêter"
        visible={canStop}
        onClicked={() => {
          const session = selectedSession.peek();
          if (session !== null) stopSession(session);
        }}
      />
    </Gtk.Box>
  );
}

export function Composer() {
  const notice = createComputed(() => {
    const local = formError();
    if (local !== null) return local;
    const code = lastError();
    return code === null ? "" : ERROR_TEXT[code];
  });

  return (
    <Gtk.Box class="composer" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <Gtk.Label
        class="notice"
        label={notice}
        visible={notice((n) => n !== "")}
        useMarkup={false}
        wrap
        xalign={0}
      />
      <NewSessionForm />
      <ReplyBox />
    </Gtk.Box>
  );
}
