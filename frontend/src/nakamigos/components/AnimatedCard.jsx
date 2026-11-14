import { memo } from "react";
import Card from "./Card";

/**
 * A Card that knows its place in a list. It used to wrap the card in a spring
 * entrance and a hover lift; the card now arrives with the stylesheet's short
 * fade (staggered by `index`) and does not move under the pointer.
 *
 * @param {number} index - Position in the list, used for the stagger
 * @param {object} cardProps - All remaining props forwarded to Card
 */
const AnimatedCard = memo(function AnimatedCard({ index = 0, staggerStep: _staggerStep, maxDelay: _maxDelay, ...cardProps }) {
  return <Card {...cardProps} idx={index} />;
});

export default AnimatedCard;
