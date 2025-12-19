import OrdersView from "../components/OrdersView";

export default function RejectedOrdersPage() {
  return <OrdersView
    title="Rejected Orders"
    defaultDiscountCode="REJECTED"
    hideDiscountFilter={true}
  />;
}