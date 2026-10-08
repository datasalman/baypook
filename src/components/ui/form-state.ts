/** What a form server action returns when it does not redirect: the error to show. Shared by server and client. */
export type FormActionState = { error: string | null };

export type FormStateAction = (prev: FormActionState, formData: FormData) => Promise<FormActionState>;
