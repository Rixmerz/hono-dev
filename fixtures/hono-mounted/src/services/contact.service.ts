export interface Contact {
  id: string;
  name: string;
}

const contacts = new Map<string, Contact>([["1", { id: "1", name: "Ada" }]]);

export function listContacts(): Contact[] {
  return [...contacts.values()];
}

export function getContact(id: string): Contact | undefined {
  return contacts.get(id);
}

export function createContact(name: string): Contact {
  const contact = { id: String(contacts.size + 1), name };
  contacts.set(contact.id, contact);
  return contact;
}

export function importContacts(names: string[]): number {
  for (const name of names) createContact(name);
  return names.length;
}
