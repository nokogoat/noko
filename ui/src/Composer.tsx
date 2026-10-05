// Zone de saisie : répondre à la session choisie (ou la reprendre), ou en créer une.
// Les champs sont créés une seule fois et jamais reconstruits, pour ne pas perdre
// le texte en cours de frappe ni le focus quand l'état d'une session change.

import Gio from "gi://Gio?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, createState, For } from "gnim";
import type { ErrorCode } from "../../shared/protocol.ts";
import { createSession, focusSession, isClosed, isLiveTerminal, sendToSession, stopSession } from "./actions.ts";
import {
  attachmentError,
  attachments,
  pasteImagesInto,
  removeAttachment,
  takeAttachments,
} from "./attachments.ts";
import { labelFactory } from "./dropdown.ts";
import { claimKeyboardOnClick } from "./keyboard.ts";
import { homeDir, shortenPath } from "./paths.ts";
import { composing, folders, lastError, selectedId, sessions, setComposing } from "./store.ts";

const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid_message: "Message refusé par le daemon.",
  unknown_session: "Session inconnue.",
  session_closed: "La session est terminée.",
  invalid_cwd: "Dossier introuvable.",
  not_resumable: "Cette session ne peut pas être reprise.",
  history_unavailable: "Historique indisponible.",
  unknown_request: "Demande expirée ou déjà traitée.",
  invalid_answers: "Réponds à toutes les questions.",
  terminal_session: "Session en cours dans un terminal : réponds-y depuis le terminal.",
  focus_unavailable: "Fenêtre du terminal introuvable.",
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

/** Dossiers proposés : ceux des sessions (plus récents d'abord), plus le dossier personnel. */
function folderChoices(extra: string | null): string[] {
  const list = [...folders.peek()];
  if (extra !== null && !list.includes(extra)) list.unshift(extra);
  if (!list.includes(homeDir())) list.push(homeDir());
  return list;
}

function NewSessionForm() {
  let name: Gtk.Entry;
  let prompt: Gtk.Entry;
  let dropdown: Gtk.DropDown;
  const model = new Gtk.StringList();
  // Chemins complets, dans l'ordre des libellés (abrégés) du menu déroulant.
  let paths: string[] = [];
  let picked: string | null = null;

  const selectedPath = (): string | null => paths[dropdown.get_selected()] ?? null;

  /** Recharge la liste en gardant (ou en choisissant) un dossier. */
  const refresh = (keep: string | null) => {
    paths = folderChoices(picked);
    model.splice(0, model.get_n_items(), paths.map(shortenPath));
    const index = keep === null ? -1 : paths.indexOf(keep);
    dropdown.set_selected(index === -1 ? 0 : index);
  };

  const submit = () => {
    const cwd = selectedPath();
    if (cwd === null) {
      report("Choisis un dossier.");
      return;
    }
    if (report(createSession(cwd, prompt.text, name.text, attachments.peek().map((a) => a.image)))) {
      takeAttachments();
      prompt.text = "";
      name.text = "";
      setComposing(false);
    }
  };

  const browse = () => {
    const dialog = new Gtk.FileDialog({ title: "Dossier de la session", modal: false });
    const current = selectedPath();
    if (current !== null) dialog.set_initial_folder(Gio.File.new_for_path(current));
    dialog.select_folder(null, null, (_src, res) => {
      try {
        const path = dialog.select_folder_finish(res)?.get_path();
        if (path) {
          picked = path;
          refresh(path);
        }
      } catch {
        // dialogue annulé
      }
    });
  };

  return (
    <Gtk.Box
      class="new-session"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
      visible={composing}
      $={() => {
        // À l'ouverture : dossier de la session affichée, sinon le plus récent.
        composing.subscribe(() => {
          if (!composing.peek()) return;
          const current = sessions.peek().find((s) => s.id === selectedId.peek());
          refresh(current?.cwd ?? null);
        });
        folders.subscribe(() => refresh(selectedPath()));
      }}
    >
      <Gtk.Box spacing={6}>
        <Gtk.DropDown
          class="folder-choice"
          hexpand
          model={model}
          factory={labelFactory(Pango.EllipsizeMode.START)}
          listFactory={labelFactory(Pango.EllipsizeMode.NONE)}
          tooltipText="Dossier de la session"
          $={(self) => {
            dropdown = self;
            refresh(null);
          }}
        />
        <Gtk.Button label="…" tooltipText="Choisir un autre dossier" onClicked={browse} />
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
        placeholderText="Premier message (Ctrl+V pour une image)"
        onActivate={submit}
        $={(self) => {
          prompt = self;
          claimKeyboardOnClick(self);
          pasteImagesInto(self);
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
    if (report(sendToSession(session, entry.text, attachments.peek().map((a) => a.image)))) {
      takeAttachments();
      entry.text = "";
    }
  };

  const placeholder = selectedSession((s) => {
    if (s === null) return "Aucune session sélectionnée";
    if (isLiveTerminal(s)) return "Session en cours dans un terminal";
    if (!isClosed(s)) return "Répondre…";
    return s.claudeSessionId === null ? "Session impossible à reprendre" : "Reprendre la session…";
  });
  const canSend = selectedSession(
    (s) => s !== null && !isLiveTerminal(s) && (!isClosed(s) || s.claudeSessionId !== null),
  );
  const canStop = selectedSession((s) => s !== null && !isClosed(s) && !isLiveTerminal(s));
  const inTerminal = selectedSession((s) => s !== null && isLiveTerminal(s));

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
          pasteImagesInto(self);
        }}
      />
      <Gtk.Button
        class="terminal"
        label="Terminal"
        tooltipText="Aller à la fenêtre du terminal"
        visible={inTerminal}
        onClicked={() => {
          const session = selectedSession.peek();
          if (session !== null) focusSession(session);
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

/** Miniatures des images jointes, chacune avec un bouton pour la retirer. */
function AttachmentStrip() {
  return (
    <Gtk.Box class="attachments" spacing={6} visible={attachments((list) => list.length > 0)}>
      <For each={attachments}>
        {(a) => (
          <Gtk.Overlay class="attachment">
            <Gtk.Picture paintable={a.thumbnail} contentFit={Gtk.ContentFit.COVER} widthRequest={56} heightRequest={56} />
            <Gtk.Button
              $type="overlay"
              class="remove"
              label="×"
              tooltipText="Retirer l'image"
              halign={Gtk.Align.END}
              valign={Gtk.Align.START}
              onClicked={() => removeAttachment(a.id)}
            />
          </Gtk.Overlay>
        )}
      </For>
    </Gtk.Box>
  );
}

export function Composer() {
  const notice = createComputed(() => {
    const local = formError() ?? attachmentError();
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
      <AttachmentStrip />
      <NewSessionForm />
      <ReplyBox />
    </Gtk.Box>
  );
}
