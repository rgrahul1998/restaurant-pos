/** Marks a Jain portion wherever a line is shown; tickets print it as "(J)" (and regular portions of the dish as "(R)"). */
export function JainTag() {
  return (
    <span
      title="Jain: no onion, garlic or root vegetables"
      className="ml-1.5 inline-block rounded-md bg-veg/10 px-1.5 py-px align-middle text-[0.7rem] font-semibold tracking-wide text-veg no-underline"
    >
      JAIN
    </span>
  )
}
