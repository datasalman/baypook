/** Light client-side checks for the details form. The server validates everything again. */

export interface DetailsInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  childName: string;
  childAge: string;
  message: string;
  terms: boolean;
  waiver: boolean;
}

export type DetailsErrors = Partial<Record<keyof DetailsInput, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** UK numbers, light touch: 0 or +44 / 0044 followed by 9 or 10 digits, spaces and dashes allowed. */
export function isUkPhone(value: string): boolean {
  const compact = value.replace(/[\s\-().]/g, "");
  return /^(?:\+44|0044|0)\d{9,10}$/.test(compact);
}

export function validateDetails(input: DetailsInput, isParty: boolean): DetailsErrors {
  const errors: DetailsErrors = {};
  if (!input.firstName.trim()) errors.firstName = "Please add your first name.";
  if (!input.lastName.trim()) errors.lastName = "Please add your last name.";
  if (!input.email.trim()) errors.email = "Please add your email address.";
  else if (!EMAIL_RE.test(input.email.trim())) errors.email = "That email address does not look right.";
  if (!input.phone.trim()) errors.phone = "Please add a phone number.";
  else if (!isUkPhone(input.phone)) errors.phone = "Please use a UK number, for example 07700 900123.";
  if (isParty) {
    if (!input.childName.trim()) errors.childName = "Please add the birthday child's first name.";
    const age = Number(input.childAge);
    if (!input.childAge.trim()) errors.childAge = "Please add their age.";
    else if (!Number.isInteger(age) || age < 1 || age > 16) errors.childAge = "Age should be between 1 and 16.";
  }
  if (input.message.length > 1000) errors.message = "Please keep this under 1,000 characters.";
  if (!input.terms) errors.terms = "Please tick to agree to the terms and privacy policy.";
  if (!input.waiver) errors.waiver = "Please tick to agree to the liability waiver.";
  return errors;
}

/** Field order, used to move focus to the first problem. */
export const DETAIL_FIELDS: (keyof DetailsInput)[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "childName",
  "childAge",
  "message",
  "terms",
  "waiver",
];
