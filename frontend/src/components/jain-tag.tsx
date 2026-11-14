/** Marks a Jain portion wherever a line is shown; tickets print it as "(J)". */
export function JainTag() {
  return (
    <span
      title="Jain: no onion, garlic or root vegetables"
      className="ml-1.5 inline-block rounded-md bg-emerald-50 px-1.5 py-px align-middle text-[0.7rem] font-semibold tracking-wide text-emerald-800 no-underline"
    >
      JAIN
    </span>
  )
}
