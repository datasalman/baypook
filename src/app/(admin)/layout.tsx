/** Pass-through: /login lives here without the admin chrome; /admin adds its own layout. */
export default function AdminGroupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
