export function PlanPicker({ plans, selectedId, onSelect }) {
  return (
    <section aria-labelledby="plan-picker-heading">
      <h2 id="plan-picker-heading">Choose a plan</h2>
      <ul className="plan-list">
        {plans.map((plan) => (
          <li key={plan.id}>
            <div
              className={plan.id === selectedId ? 'plan plan--selected' : 'plan'}
              onClick={() => onSelect(plan.id)}
            >
              <h3>{plan.name}</h3>
              <p>{plan.priceLabel} per month</p>
              {plan.id === selectedId && <p>Selected</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
