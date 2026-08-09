export function FormError({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-red-600">{children}</p>;
}

export function FormHint({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}
