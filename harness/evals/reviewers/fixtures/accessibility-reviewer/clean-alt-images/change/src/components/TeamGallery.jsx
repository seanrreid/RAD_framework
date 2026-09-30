export function TeamGallery({ members }) {
  return (
    <section aria-labelledby="team-heading">
      <h2 id="team-heading">Meet the team</h2>
      <img src="/images/divider-wave.svg" alt="" className="section-divider" />
      <ul className="team-grid">
        {members.map((member) => (
          <li key={member.id}>
            <figure>
              <img
                src={member.photoUrl}
                alt={`Portrait of ${member.name}`}
                width="200"
                height="200"
              />
              <figcaption>
                {member.name}, {member.role}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      <img src="/images/office-map.png" alt="Map showing our office at 12 Harbour Street, next to the ferry terminal" />
    </section>
  );
}
