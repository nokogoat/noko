// Zone de saisie : répondre à la session choisie (ou la reprendre), ou en créer une.
// Les champs sont créés une seule fois et jamais reconstruits, pour ne pas perdre
// le texte en cours de frappe ni le focus quand l'état d'une session change.

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, createState, For } from "gnim";
import { createSession, deleteSession, focusSession, isClosed, isLiveTerminal, sendToSession, stopSession } from "./actions.ts";
import {
  attachmentError,
  attachments,
  pasteImagesInto,
  removeAttachment,
  takeAttachments,
} from "./attachments.ts";
import { labelFactory } from "./dropdown.ts";
import { t } from "./i18n.ts";
import { claimKeyboardOnClick } from "./keyboard.ts";
import { homeDir, shortenPath } from "./paths.ts";
import { composing, folders, lastError, selectedId, sessions, setComposing } from "./store.ts";

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
      report(t.peek().composer.chooseFolder);
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
    const dialog = new Gtk.FileDialog({ title: t.peek().composer.folderTip, modal: false });
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
          tooltipText={t((s) => s.composer.folderTip)}
          $={(self) => {
            dropdown = self;
            refresh(null);
          }}
        />
        <Gtk.Button label="…" tooltipText={t((s) => s.composer.browseTip)} onClicked={browse} />
      </Gtk.Box>
      <Gtk.Entry
        placeholderText={t((s) => s.composer.namePlaceholder)}
        maxLength={200}
        $={(self) => {
          name = self;
          claimKeyboardOnClick(self);
        }}
      />
      <Gtk.Entry
        placeholderText={t((s) => s.composer.firstMessagePlaceholder)}
        onActivate={submit}
        $={(self) => {
          prompt = self;
          claimKeyboardOnClick(self);
          pasteImagesInto(self);
        }}
      />
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label={t((s) => s.composer.cancel)} onClicked={() => setComposing(false)} />
        <Gtk.Button class="suggested" label={t((s) => s.composer.create)} onClicked={submit} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

/** Délai pour confirmer la suppression par un second clic. */
const CONFIRM_DELAY_MS = 3000;

/**
 * Retire une session terminée de la liste. Deux clics : le premier arme le bouton,
 * le second (dans les 3 s, sur la même session) supprime.
 */
function DeleteButton() {
  const [armedId, setArmedId] = createState<string | null>(null);
  let source = 0;

  const disarm = () => {
    if (source !== 0) GLib.source_remove(source);
    source = 0;
    setArmedId(null);
  };

  const canDelete = selectedSession((s) => s !== null && isClosed(s));
  const armed = createComputed(() => armedId() !== null && armedId() === selectedId());

  return (
    <Gtk.Button
      class={armed((a) => (a ? "delete armed" : "delete"))}
      label={createComputed(() => (armed() ? t().composer.confirmDelete : t().composer.delete))}
      tooltipText={t((s) => s.composer.deleteTip)}
      visible={canDelete}
      $={() => {
        selectedId.subscribe(disarm);
      }}
      onClicked={() => {
        const session = selectedSession.peek();
        if (session === null) return;
        if (armedId.peek() !== session.id) {
          disarm();
          setArmedId(session.id);
          source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_DELAY_MS, () => {
            source = 0;
            setArmedId(null);
            return GLib.SOURCE_REMOVE;
          });
          return;
        }
        disarm();
        deleteSession(session);
      }}
    />
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

  const placeholder = createComputed(() => {
    const s = selectedSession();
    const text = t().composer;
    if (s === null) return text.noSession;
    if (isLiveTerminal(s)) return text.liveTerminal;
    if (!isClosed(s)) return text.reply;
    return s.claudeSessionId === null ? text.notResumable : text.resume;
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
        label={t((s) => s.composer.terminal)}
        tooltipText={t((s) => s.composer.terminalTip)}
        visible={inTerminal}
        onClicked={() => {
          const session = selectedSession.peek();
          if (session !== null) focusSession(session);
        }}
      />
      <Gtk.Button
        class="stop"
        label={t((s) => s.composer.stop)}
        visible={canStop}
        onClicked={() => {
          const session = selectedSession.peek();
          if (session !== null) stopSession(session);
        }}
      />
      <DeleteButton />
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
              tooltipText={t((s) => s.composer.removeImage)}
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
    return code === null ? "" : t().errors[code];
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
