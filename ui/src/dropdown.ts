// Libellés des menus déroulants (Gtk.DropDown). Ceux de la fabrique par défaut ne se
// raccourcissent pas : un long libellé élargirait la carte au-delà de la fenêtre, qui
// serait alors coupée à droite.

import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";

export function labelFactory(ellipsize: Pango.EllipsizeMode): Gtk.SignalListItemFactory {
  const factory = new Gtk.SignalListItemFactory();
  factory.connect("setup", (_f, item) => {
    (item as Gtk.ListItem).set_child(new Gtk.Label({ ellipsize, xalign: 0, useMarkup: false }));
  });
  factory.connect("bind", (_f, item) => {
    const listItem = item as Gtk.ListItem;
    const label = listItem.get_child() as Gtk.Label;
    label.set_label((listItem.get_item() as Gtk.StringObject).get_string());
  });
  return factory;
}
