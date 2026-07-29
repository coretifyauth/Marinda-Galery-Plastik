import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
};

const variantClasses = {
  primary: "bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed",
  secondary: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`rounded-lg px-4 py-2 text-sm font-medium ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
